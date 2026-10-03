# pi-only 会话持久化：评估与实施

> 2026-10-04 评估并**当日实施完成**（见文末实施状态）。问题：只保存 pi 会话文件，不落盘 dsh 投影会话文件（`~/.dsh/sessions/...`），是否可行、要做哪些工作。
> 结论先行：**可行，且与 2026-10-03 被否决的 "pi-backed persistence" 不是同一个方案**。
> 预估 600–800 行新代码 + 测试，2–3 个工作段。建议按两期落地。

---

## 1. 与上次被否决方案的区别（关键）

上次否决的是"让 dsh 的**实时写路径**直接写 pi 格式"：宿主全部写者的必经层、fail-closed 词汇、
单写者锁、append-only vs pi compaction 重写——四条硬冲突全部来自**写路径穿透**。

本方案的写路径根本不落盘：

```
实时（不变）：  pi RPC 事件 → 翻译层 → session.append() → 内存 Session（投影实时折叠）
                                        ↘ 持久化后端 = 内存汇（append 收下即弃，flush=no-op）
落盘（唯一）：  pi 进程自己写 <dataDir>/<sessionId>.jsonl（现状已在写）
恢复（新增）：  重启/resume → 读 pi 文件 → 反向翻译成 dsh 事件流 → seed 内存 Session
列表（新增）：  侧栏/搜索语料 → 扫 pi 目录合成 SessionHeader（懒式，不落盘）
```

宿主对 dsh 日志的全部消费（列表、搜索、冷读、导出）都经 `SessionPersistence` 抽象接口
（可选服务，live 优先），因此**换掉这个后端，宿主零改动**。

## 2. 宿主依赖面（实测）

| 宿主消费 | 数据源 | pi-only 下的表现 |
|---|---|---|
| 侧栏会话列表 | `ApiSessionList.list()` → `SessionCorpus.listSessions()` → `persistence.list()` | 合成 header 即可，UI 零改动 |
| 冷会话打开（重启后点历史） | `factory.resume()` → `persistence.open(id,'write').read()` | 读路径翻译 pi 文件为事件流 |
| 全文搜索（session-query，默认关） | `SessionCorpus.load()` → 同上 | 自动经翻译层工作 |
| 导出 ZIP | session-log-export → corpus.load() | 同上 |
| 活会话一切（聊天/轨迹/用量/turn导航/修改可视化） | live Session 内存投影 | **完全不变**（现状已工作） |
| resume 上下文 | pi 驱动自己 `--session <file>` 重载 | 完全不变（P4 已验证） |

`SessionCorpus` 源码确认：persistence 是可选服务，缺席时列表退化为"仅活会话"——
所以**合成 list() 不是锦上添花而是必需项**，否则侧栏重启后清空。

## 3. 设计：PiSessionPersistence

pi-agent 插件内新增一个 `SessionPersistence` 子类（抽象契约 5 个方法），
替换 base 的 `session-persistence-jsonl` 行：

```yaml
- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: pi-session-persistence
      name: '@deepseek-ai/dsh-pi-agent'   # 包内导出该 Service
      config: { mode: 'pi-only' }         # 保留 dual 模式开关
```

服务键来自 `SessionPersistence.identity`（抽象类自带），jsonl 后端就是这个挂法
（`class JsonlSessionPersistence extends SessionPersistence`，base 行 disable+insert 即换）。

各方法实现：

| 方法 | 实现 |
|---|---|
| `create(header)` | 内存句柄（seq 计数、append 收进 RAM 数组，flush=no-op） |
| `open(id, 'write')` | **重放路径**：读 `<dataDir>/<id>.jsonl` → 反向翻译成事件数组 → 内存句柄预载；随后宿主 resume 的 `interruptedTurnClosers` 照常工作（重放出未闭合 turn 就自动补 closer） |
| `open(id, 'read')` | 同上（导出/搜索用） |
| `list()` / `stat(id)` | 扫 dataDir，读每文件首行（`type:"session"`：cwd/timestamp）+ `session_info` 条目（sessionName/updatedAt），合成 `SessionPersistenceSnapshot` |
| `flush()` | no-op |

工厂侧（PiAgentLoop）**几乎不用改**：create/resume 本来就经 `ctx.get('sessionPersistence')`。

## 4. pi 文件 → dsh 事件反向翻译

pi 条目词汇（session-manager.d.ts，10 种，全部可映射）：

| pi entry | dsh 事件 |
|---|---|
| `session`（首行） | SessionHeader（id=文件名、cwd、createdAt） |
| `message`(role=user) | `turn/start`（合成）+ `user/message`(surface) |
| `message`(role=assistant) | `step/start`（合成）+ `request/header`+`request/context`（近似）+ `assistant/message`(surface, 含 usage/content blocks) |
| `message`(role=toolResult) | `tool/call`（由前一条 assistant 的 toolCall 块合成）+ `tool/result`(surface) |
| `model_change` | `model/selection`（log-only） |
| `thinking_level_change` | 忽略（或 `request/context` 更新） |
| `compaction` | `compaction/summary` 或 `system/message` 占位 |
| `branch_summary` / `label` / `custom_message` | 忽略或 `system/message` |
| `session_info` | `session/title`（sessionName → 标题回填） |

要点：
- **分支**：pi 是 parentId 树。只重放"活叶链"（末条目的祖先链，与 workbench
  `piChatSnapshot` 同算法）；历史分支在 dsh UI 不可见（pi TUI 里仍在）。
- **turn/step 合成**：pi 无显式边界；user 消息开新 turn、assistant 消息推 step——
  与正向翻译的相位机同一套规则，可抽成共享纯函数。
- **usage/内容块**：与正向翻译复用同一映射表（input/cacheRead → TokenUsage、
  text/thinking/toolCall → text/reasoning/tool-call）。
- **compaction 重写**：pi compaction 会 `_rewriteFile()`——重放按"文件当前内容"翻译，
  天然幂等，无 append-only 冲突。

## 5. 会失去什么（诚实清单）

| 丢失项 | 影响 | 对策 |
|---|---|---|
| approval/asked+decided 审计对 | 重启后审批历史消失 | 接受（审计性质） |
| feedback 好坏评分 | 重启后评分消失 | 接受，或 dual 模式留这些 |
| command/run-done 记录 | 斜杠命令历史消失 | 接受 |
| 图片附件 | 重放时 image 块降级/丢弃 | v1 接受；二期做 attachment 登记 |
| pi 格式漂移 | 反向翻译多一份 pi 格式依赖 | 与正向帧翻译同一耦合级别，可接受 |
| dsh 日志的跨内核可移植性 | 会话史绑定 pi 格式 | **这正是目的**：pi 文件成为单一事实源，pi TUI 可直接续聊同一会话（原始诉求） |

附带收益：`~/.dsh/sessions/` 不再增长（当前是双份存储）；双事实源漂移问题消失；
workbench 会话桥对 persistence 的校验走合成 list 后继续工作（需回归）。

## 6. 工作分解

| # | 工作 | 规模 |
|---|---|---|
| 1 | PiSessionPersistence：内存句柄 + list/stat 目录合成 + patch 行替换 + `persist: dual\|pi-only` 配置开关 | ~250 行 |
| 2 | 反向翻译器（entry 走链 + turn/step 合成 + 内容块/usage 复用映射） | ~350 行 |
| 3 | 标题/模型回填：`session/title` → `set_session_name` RPC；重放读 sessionName | ~60 行 |
| 4 | 金样测试：pi fixture 文件 → 期望事件序列；resume 往返；list 合成 | ~半天 |
| 5 | 回归：workbench 会话桥、导出、搜索（可后置） | 少量 |

**总量 600–800 行 + 测试，2–3 个工作段。** 无契约冲突、宿主零改动、工厂几乎零改动。

## 7. 实施状态（2026-10-04 完成）

全部落地为单次实现（一期+二期合并），开关：启动时 `DSH_PI_ONLY=1` 启用，默认 dual 不变。

| 项 | 实现 | 验证 |
|---|---|---|
| 反向翻译器 | `src/replay.ts`：活叶链遍历 + turn/step 合成 + 内容块/usage 复用正向映射 + model_change→model/selection + session_info→session/title；分支枝条剔除 | 金样测试 2/2（事件序列、seq 连续、tool/call↔result 关联、时间戳透传） |
| 持久化服务 | `src/persistence.ts`：`PiSessionPersistence extends SessionPersistence`（内存句柄 + list/stat 扫描合成），经 `@deepseek-ai/dsh-pi-agent/persistence` 子路径导出 | loader 子路径解析正常 |
| patch 开关 | cordis.patch.yml 用 `!!js process.env.DSH_PI_ONLY` 条件 disable jsonl 行 + 插入 pi 行 | pi-only 启动 0 激活失败 |
| 实测（pi-only） | 侧栏按工作区分组显示 pi 目录合成会话（无标题→Untitled、mtime→时间）；冷会话点开：历史消息/12 turns 13 steps/161K tok·Cache 90%/模型路由全部重放恢复；冷会话续聊：pi 准确复述此前执行过的 `ls -A | wc -l && ls -A` | 全链路通过 |
| 回归（dual） | 不带 env 启动：jsonl 行恢复、标题来自 dsh 日志、workbench 共存正常 | 通过 |

已知的可接受退化（重放后消失）：审批审计对、feedback、command/run 记录、compaction 标记、
分支历史（只重放活叶链）、图片附件（v1 丢弃）。空会话（无 pi 文件）重启后从列表消失。

## 8. 历史分期建议（已合并实施）

- **一期（最小可用）**：#2 反向翻译器 + 工厂 resume 直读 pi 文件（绕过 persistence，
  `persistence.open` 走内存空实现）。代价：侧栏列表空（只有活会话）。先验证重放质量。
- **二期（完整）**：#1 list/stat 合成 + 正式替换 persistence 行 → 列表/搜索/导出全通。
- 随时可回退：`persist: dual` 配置切回现行为（现状已在生产验证）。
