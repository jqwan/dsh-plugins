# π 工作台 → dsh 插件（Workbench）落地计划

> 状态：**一期（iframe 复用）已完成；二期 P2-M1/M2 已交付并按用户反馈修订（v1.1），P2-M3 细节对齐进行中**　|　源工程：`/Users/jqk/projects/workspace`　|　目标仓库：本仓库 `dsh-plugins`
> 日期：2026-09-05

## P2. 第二期：原生融合（当前阶段）

一期把工作台以 `shell.overlay` 全屏 iframe 方式嵌入，用户反馈这不是想要的融合形态。**第二期目标：把工作台的 UI 与交互直接长进 dsh 的壳**——自定义 dsh 的侧边栏和中心区域，接近原工作台的 UI 及交互方式。

### P2.1 已确认的产品决策（用户拍板）

1. **中心区域 = 可切换界面族**：dsh 会话（原生聊天）、pi 终端、任务看板、便签看板、会话看板之间切换；统计与回收站放侧栏底部图标区入口。dsh 会话聊天**保持 dsh 原生**，不自绘。
2. **侧边栏整体工作台化**（`sidebar` 槽位整列替换）：
   - 顶部小图标按钮区：**π / dsh logo 切换**，决定会话列表显示 pi 会话还是 dsh 会话（两种会话不混排）；
   - 中部 = 任务/便签/会话看板入口按钮区 + 会话列表区；
   - 底部小图标按钮区：替换 dsh 原生设置为**工作台设置**按钮，显示模式设置功能融合进设置弹层。
3. **范围**：全部原生化（最终形态），按里程碑渐进交付，核心（侧栏树 + pi 终端 + 看板骨架）先行。
4. 后端 `workbench-web` 保留：REST API + SSE + `/workbench/ws` PTY + dsh 会话桥不变，客户端插件直接消费。

### P2.2 技术路径（已核实 dsh 源码）

- **slot 优先级遮蔽**：`single` 槽位同 cell 不同 `priority` 共存，**priority 最低者渲染**（`ui-slots/src/index.ts` SlotCore.register）。原生 ui-sidebar 以 priority 0 占据 `sidebar`；我们的注册用更低 priority 即可整列接管，且原生条目仍在册、其子槽位声明不塌缩（塌缩只发生在 dispose）。
- **侧栏接管深度（v1.1 调整）**：最初整列遮蔽 `sidebar`，实测后改为**只遮蔽 `sidebar.workspaces`（会话浏览区）**——原生壳保留（品牌行、折叠状态机、New Session、`sidebar.settings` 原生设置行）。原因：dsh 原生设置面板的开关状态是 ui-settings-general 组件内部 `useState`，无服务/命令可从外部打开，整列替换会让设置彻底不可达；原生折叠也顺带归位。工作台的统计/回收站/工作台设置图标放在浏览区底部（紧邻原生设置行），折叠时渲染竖排图标轨（`expandSidebar()` 请求展开）。中心面覆盖起点由区域 DOM `getBoundingClientRect().left` 经 ResizeObserver 回写。
- **中心区切换**：不动 `conversation`（原生聊天零风险）。工作台界面（pi 终端/看板）通过 `shell.overlay` 新增条目渲染为**覆盖中心列的不透明图层**（左侧偏移 = 侧栏当前宽度，来自 `sidebar` owner props → 共享 store；`pointer-events:auto` 只给中心面）。当前视图为 dsh 会话时该条目渲染 null → 原生聊天自然露出。
- **dsh 会话列表与打开**：客户端 `sessions` 服务（ISessions，`api-session-controller/client`）暴露 `list: ObservableSnapshot<SessionListState>`（`{ids, byId, current, phase}`）、`open(id)`、`clear()`、`refresh()`、`create()`。工作台树的 dsh 会话点击 → `sessions.open(dshSessionId)` + 视图切回 dsh；`list.current` 被外部改变（原生入口打开会话）→ 中心视图跟随切回 dsh。非工作台创建的原生 dsh 会话可在 dsh 模式列表尾部以"原生会话"分组兜底展示（读 `list`）。
- **pi 终端**：xterm.js 进客户端 bundle（`@xterm/xterm` + `addon-fit`），WebSocket 直连同源 `/workbench/ws`，协议不变；输入所有权/回放/尺寸同步走既有 REST+WS。
- **数据层**：`fetch /workbench/api/*` + `EventSource /workbench/api/events`（同源，无需鉴权），折叠进客户端 snapshot store；任务/便签/运行态与会话消息基线全部来自工作台后端。
- **"新回复"提醒（v1.2，替换一期未读水位）**：完全对齐 dsh 原生 `completed` 提醒语义——纯客户端内存、按会话一个布尔绿点、刷新即清、选中即消费、不计数。dsh 会话直接读宿主 `sessions` 服务快照的 `completed` 位（宿主 SessionListManager 的 running→idle 边检测零重实现）；pi 会话在客户端 store 复刻同一段算法（`reconcilePi`），边源换成 `latestMessageId` 变化（pi 的 PTY 存活位不随回合翻转，JSONL 新助手消息即"回合有新产出"）：首见只记基线、变化且非当前打开 → 点亮、打开 → 消费。服务端 `/read` 端点、`store/unread.js` 水位机制与 `unreadCount` 字段移除（`latestMessageId` 保留供基线对比）。
- **四色状态点（v1.2.1）**：侧栏行与看板卡片全面采用 dsh 原生 `StateDot`（`@deepseek-ai/dsh-client-ui-primitives`，含蓝色追逐环动画），优先级 warning > error > ongoing > done，空闲不显示点。**蓝 ongoing**：pi 取 PTY 存活位、dsh 取快照 `running`；**绿 done**：v1.2 的"新回复"提醒（dsh 宿主 completed 位 / pi latestMessageId 边）；**琥珀 warning**（仅 dsh）：注入宿主 `uiSession` 服务读 `pendingInteractions`（approval/plan-review/question，pi 的审批在 TUI 内部探测不到）；**红 error**（仅 pi）：终端视图上报连接错误/断开（store `piErrors`，纯内存），dsh 快照无错误位。
- **pi 蓝色语义与红色扩展（v1.2.2）**：pi 的"运行中"不再取 PTY 存活位（打开过就一直蓝），改由服务端 `piTurnState()` 读会话文件最后一条消息：user/toolResult 结尾或 assistant(toolUse) = 回合进行中（`agentBusy`，且要求 TUI 存活），assistant(error) 结尾 = 回合出错（`turnFailed`，红色'回合出错'，直到下一回合推进）；PTY 存活但空闲在提示符不显示点。**dsh 无红色**：宿主会话列表快照没有失败位（失败只存在于会话对象生命周期流，原生会话行也从不显示红色），维持琥珀/蓝/绿三色。
- **主题（v1.3 收敛）**：仅保留 classic 单一风格（配色效仿 dsh 原生，四风格设置不再保留）；亮/暗跟随 dsh（读 documentElement colorScheme + MutationObserver），工作台 CSS 变量只作用于自己的表面（侧栏 + 中心面 + 弹层），不污染原生区域。
- **入口落位（v1.3 调整）**：统计/回收站/会话/便签/任务五个看板入口收进侧栏顶部工具行（搜索与视图选项旁），不是 P2.1 设想的底部图标区；原生设置行原样保留，工作台设置未并入原生设置面板。

### 看板交互与定时输入

原生任务、便签、会话和回收站共用卡片间距、操作区分隔线与键盘焦点样式；工具栏允许换行，长标题和连续文本允许折行。会话卡片支持 Enter 和空格打开。便签标题可选，保存要求内容非空。回收站为空时禁用清空按钮。

每日、每周和每月定时配置要求小时为 0–23、分钟为 0–59；无效时刻规范化为 `null`。便签排序使用集合判断已选记录，保留未选记录的相对顺序与内容更新时间。

### P2.3 二期里程碑

| 里程碑 | 内容 | 验证 |
|---|---|---|
| P2-M1 基座 | 客户端数据层（API+SSE store）；`sidebar` 整列接管（logo 切换、看板入口、pi/dsh 会话树、底部图标区）；中心切换面骨架（视图状态机 + dsh 原生聊天回退） | 构建 + tsc；浏览器实测树渲染/切换/打开 dsh 会话 |
| P2-M2 pi 终端 | xterm + WS PTY 进中心区；选中 pi 会话 → 终端；回放/输入所有权/尺寸同步 | 终端可交互，重启会话/多会话切换正常 |
| P2-M3 看板原生化 | 任务看板（卡片/筛选/新建编辑/颜色/状态）、便签看板（含提醒/发送到会话）、会话看板、统计、回收站、设置（含显示模式） | 对照一期 iframe 功能逐项回归 |
| P2-M4 收尾 | 新建任务/会话弹窗、dsh 徽标与"原生会话"兜底分组、窄屏断点、iframe 前端退役评估 | 全功能手测 + 四风格×亮暗 |

### P2.4 风险

| 风险 | 应对 |
|---|---|
| 遮蔽 `sidebar` 后原生 New Session / 设置入口消失 | 工作台树提供新建会话（含 dsh）；设置由工作台底部区提供；如需原生设置可后续加隐藏入口 |
| `shell.overlay` 覆盖面与弹层层级冲突 | 中心面只盖中心列；工作台自己的弹层渲染在中心面内部；原生 toast/palette 在其上属可接受 |
| 客户端 bundle 体积（xterm ~300KB） | 可接受（个人工具）；必要时动态 import |
| dsh 版本升级改变 slot 合同 | 只依赖公开合同（SlotMap/ISessions/ILayout），不深导入内部组件 |

---

## 0. 一期实施结果与计划偏差（2026-09-05）

已完成并验证的内容：

- **Host 包** `packages/task/workbench-web`（`@deepseek-ai/dsh-workbench-web`）：server.js 全量移植为 `createRuntime()` 工厂（`src/runtime.js`），Express + SSE + 静态资源 + `/workbench/ws` TUI WebSocket 全部挂到 `ctx.webServer`；`store.js`（+`kind` 迁移与可配置路径）、`session.js`、`unread.js`、`tui-executor.js`（+`configurePi`）、`executor.js` 原样移植；pi CLI 入口可用 `piCliEntry` 配置注入。
- **dsh 会话桥** `src/dsh/bridge.js`：真实实现。创建走 `sessionController.create({ cwd })`（带完整 agent 生命周期与持久化）；事件读取走 `sessionController.inspect()` 折叠为 `parseSessionFile` 同形视图（150ms 去抖 + session/event 驱动）；运行态由 `agent/status` 事件驱动；`prompt`/`cancel` 转发；首条用户输入自动拼接任务描述 + AGENTS.md 上下文（对齐 pi 的 `--append-system-prompt` 语义）。
- **Client 包** `packages/client/ui-workbench`（`@deepseek-ai/dsh-client-ui-workbench`）：`sidebar.footer.action` 入口按钮 + `shell.overlay` 全屏 iframe，共享 visibility store；`theme.ts` 读取宿主 `documentElement.style.colorScheme` 并 MutationObserver 推送 postMessage。
- **前端**：`ui/chat.js` 自绘聊天（消息流 + 输入框 + 停止按钮 + 未读/运行指示），全部路径改挂 `/workbench` 前缀，新建会话弹窗支持选择 pi/dsh 类型（`dshAvailable` 时），会话树带 dsh 徽标。
- **验证**：`pnpm run build` 全绿；包内 `node --test` 8/8；`scripts/smoke-workbench.mjs`（HTTP 面 11 项）与 `scripts/smoke-dsh-bridge.mjs`（桥链路 8 项，注入假 sessionController）全过；`scripts/import-data.mjs` 已用真实 workspace 数据演练（17 任务/8 便签/60 会话文件，含 sessionFile 路径重写）。

与原计划的偏差（实现期决策）：

1. **dsh 会话创建走 `ctx.sessionController`，不是 `ctx.sessions.create()`**——后者创建的会话挂在插件 fiber 上且不持久化；sessionController 才带 agent 生命周期。
2. **宿主服务类型用本地 shim（`src/host-services.ts`）**，不依赖 `@deepseek-ai/dsh-api-session-controller` 等 devDeps——否则会把 rc.1 版本线拉进 lockfile，与既有 alpha.3 版本产生双实例、打类型增强。本仓库所有 `@deepseek-ai` 依赖须**精确锁定** `0.1.2-alpha.3`。
3. **任务上下文注入方式**：pi 版是每轮 system prompt 注入；dsh 版是首条用户输入前拼接一次（后续轮次上下文已在会话历史中）。
4. **dsh 会话聊天为按步刷新**（assistant/message 事件落地后出现），非逐 token 流式；宿主 `follow` 流式帧可作后续增强。
5. dsh 会话的 cost 统计暂为 0（dsh 的 TokenUsage 不含价格字段，pi 自带 `usage.cost`）。

待真实环境联调清单：安装进 web profile 后验证 pi TUI（PTY 在宿主进程内运行）、dsh 会话创建与聊天、主题跟随、`install:profile` 与 node-pty 编译放行、数据导入后全功能回归。

## 1. 背景与已确认决策

把 workspace 工程（Express 后端 + 原生浏览器前端 + xterm/PTY 运行 pi TUI 的个人工作台）改造为 dsh 插件，嵌入 dsh web。已确认的产品决策：

1. **前端载体：先 iframe 复用现有前端**，UI 与现状 100% 一致；第二期再评估把部分面板渐进迁移成 React slot。
2. **dsh 会话在工作台内自绘聊天界面**（iframe 内 vanilla JS 渲染聊天流 + 输入框，风格对齐现有 UI），不跳转 dsh 原生聊天。
3. **不做独立运行双模式**：workspace 的 `node server.js` 形态退役，现有 `data/tasks.json`、便签、pi 会话 JSONL 一次性导入插件数据目录。
4. 插件落在本仓库 `packages/` 下，沿用 `authorization-web` / `ui-authorization` 范例的 Host+Client 组合模式与构建/安装流程。

核心需求：工作台同时支持 **pi TUI 会话**与 **dsh 会话**两种界面；一个任务下可混排两种会话并在同一棵会话树中展示；dsh 会话接入全部工作台功能（任务管理、未读、收藏、重命名、归档/回收站、便签/提醒、统计）。

## 2. 总体架构

```text
浏览器
└─ dsh web (SPA)
   ├─ ui-workbench (Client 插件, React slot)
   │   ├─ sidebar.footer.action → 工作台入口按钮
   │   └─ shell.overlay → 全屏面板 = <iframe src="/workbench/">
   │        │  postMessage: dsh 亮/暗主题 → 工作台显示模式
   │        ▼
   │   工作台前端（public/ 原样复用 + dsh 聊天渲染增量）
   │        │  fetch /workbench/api/*、SSE /workbench/api/events、WS /workbench/ws
   └─ HTTP(SSE/静态) ▲
                     │
dsh 宿主 Node 进程
└─ workbench-web (Host 插件, Cordis)
    ├─ ctx.webServer.register prefix '/workbench'
    │   ├─ /workbench/api/*      ← Express Router（REST API 原样移植）
    │   ├─ /workbench/api/events ← SSE tasks_changed
    │   ├─ /workbench/*          ← 静态文件（public/ + vendor/xterm）
    │   └─ registerUpgrade /workbench/ws ← ws 服务器（TUI 协议不变）
    ├─ 任务/便签存储（lib/store.js 原样，数据目录 = 插件数据目录）
    ├─ pi 运行时（lib/tui-executor.js + executor.js + node-pty 原样）
    └─ dsh 会话桥（新模块）
        ├─ ctx.sessions.create({ meta:{cwd} }) 创建 dsh 会话
        ├─ 事件流适配 → 与 parseSessionFile() 同形 {header, entries, stats}
        └─ prompt/cancel 转发 + SSE 变更通知
```

## 3. 包结构

### 3.1 Host 包 `packages/task/workbench-web`（`@deepseek-ai/dsh-workbench-web`）

```text
workbench-web/
├─ package.json            # dsh.bundle.patch；deps: express, ws, node-pty
├─ cordis.patch.yml        # insert: [{ id: workbench-web, name: @deepseek-ai/dsh-workbench-web }]
├─ tsconfig.json
├─ src/
│  ├─ index.ts             # apply(ctx)：inject ['webServer','sessions']，装配 + 路由注册
│  ├─ context.ts           # 宿主上下文对象：config、store、executors、dsh 桥的集中装配（替代 server.js 顶层）
│  ├─ routes.ts            # Express Router：任务/便签/会话/回收站/配置/目录选择 全部 REST
│  ├─ sse.ts               # /api/events SSE + 变更去抖通知（tasks_changed）
│  ├─ tui-ws.ts            # /workbench/ws upgrade → ws 服务器（tui_hello/input/resize 协议不变）
│  ├─ static.ts            # public/ + vendor/xterm 静态文件回源
│  ├─ store/store.js       # ← workspace lib/store.js（+kind 字段迁移）
│  ├─ store/session.js     # ← workspace lib/session.js（pi JSONL 解析）
│  ├─ pi/tui-executor.js   # ← workspace lib/tui-executor.js（PTY/回放/输入所有权）
│  ├─ pi/executor.js       # ← workspace lib/executor.js（遗留 pi 进程清理）
│  └─ dsh/bridge.js        # dsh 会话桥（创建/事件适配/输入/状态）
├─ public/                 # ← workspace public/（index.html/app.js/style.css/ui/）+ 增量改造
├─ vendor/xterm{,-fit,-search}/  # ← @xterm 三件套产物拷贝
├─ scripts/import-data.mjs # 旧 workspace 数据一次性导入
└─ test/                   # ← workspace test/（store/session 层；unread 层随 v1.2 移除）
```

要点：
- **Express 直接挂载**：已核实 `ctx.webServer` 的 prefix handler 签名是原生 `(req: IncomingMessage, res: ServerResponse)`（`packages/host/webserver/src/index.ts:47`），Express app 可作为 handler 直接接收，`server.js` 的路由逻辑几乎原样搬进 `routes.ts`，只是不再 `listen`。
- **静态文件**：`express.static` 指向包内 `public/` 与 `vendor/`；xterm 三件套从 `@xterm/*` 拷贝为纯静态产物，不再依赖宿主 node_modules。
- **pi 启动方式不变**：`process.execPath` + pi 包 cli 入口 + `--session --tui-mode regular --use-theme …` 参数族原样保留；缺失 pi 时降级为仅 dsh 会话（新建会话界面隐藏 pi 选项）。

### 3.2 Client 包 `packages/client/ui-workbench`（`@deepseek-ai/dsh-client-ui-workbench`）

```text
ui-workbench/
├─ package.json            # dsh.client: { platform: 'web' }；exports ./client
├─ cordis.patch.yml        # insert: [{ id: client-ui-workbench, name: @deepseek-ai/dsh-client-ui-workbench }]
├─ tsconfig.json
└─ src/
   ├─ index.ts             # 空 node 半 apply（仓库惯例）
   ├─ invariant.ts
   └─ client/
      ├─ index.ts          # apply：注册 slot；inject ['slots','locale']
      ├─ store.ts          # createWorkbenchStore()：面板可见性（两个 slot 组件共享）
      ├─ entry-button.tsx  # sidebar.footer.action：工作台入口按钮
      ├─ overlay.tsx       # shell.overlay：全屏 iframe + 主题桥（postMessage）
      ├─ theme.ts          # 读取 dsh 当前亮/暗（documentElement 色 scheme/token）+ MutationObserver → postMessage
      └─ workbench.module.css
```

- 遵守 `packages/client/AGENTS.md` 纪律：组件只拿四份 props；共享可见性状态走 `register` 时声明的 store；不 import 其他 feature 包运行时值。
- **iframe 同源**（`/workbench/` 与 dsh SPA 同 host:port），前端 `api()` 直接可用，无需额外鉴权（webserver 仅回环监听）。

## 4. 数据与会话模型变更

`data/tasks.json` 中子会话对象新增 `kind: 'pi' | 'dsh'`（缺省迁移为 `'pi'`，兼容旧数据）：

| 字段 | pi 会话 | dsh 会话 |
|---|---|---|
| `kind` | `'pi'` | `'dsh'` |
| `sessionFile` | 绝对路径（不变） | 不使用（null） |
| `dshSessionId` | 不使用 | `ctx.sessions` 会话 id |
| 其余（title/favorite/status/archivedAt/restorableWithTask…） | 共用 | 共用 |

- pi 会话：一切照旧（JSONL 由 tui-executor 单写入者写；session.js 解析）。
- dsh 会话：**不直接写 dsh 的 JSONL**；标题自动命名/统计通过 dsh 事件流适配层读取，输入通过 dsh Session API 进入。
- `store.js` 归一化迁移：补 `kind` 默认值；`sessionFile` 允许为 null（dsh 会话）。
- 任务级不新增必填字段；新建会话时选择类型（pi / dsh），记住任务内最近一次选择（内存态即可）。

## 5. dsh 会话桥设计（`src/dsh/bridge.js`）

职责：让 dsh 会话在服务端呈现为与 pi 会话同形的接口。

1. **创建**：`ctx.sessions.create(id, { meta: { cwd: workingDir } })`，种子上下文 = 任务标题/描述 + 各工作目录 `AGENTS.md`（对齐 pi 版 `piSystemPrompt` 语义；注入方式用 seed 首条 user 消息或 agentPreset，实现时按 `ctx.sessions` 实际 API 定）。
2. **读取/适配**：把 dsh 会话事件流折叠为 `parseSessionFile()` 同形结构 `{ exists, header:{cwd}, entries, leaf, lastMessage, stats }`；`entries[].message.{role,content,timestamp,id}` 语义对齐 pi message entry，使 unread.js / publicSession / 前端渲染零改动或极小改动。
3. **输入**：`sendPrompt(dshSessionId, text)` → Session API prompt；`stop()` → cancel。便签发送（`POST /api/notes/:id/send`）按会话类型分流：pi 走 PTY write，dsh 走本接口。
4. **运行状态**：`running` = dsh 会话 turn 进行中（Session 状态查询），供 `publicTask`/会话树显示。
5. **变更通知**：订阅 session 事件，去抖后走现有 SSE `tasks_changed(reason:'session')`。
6. **生命周期对齐**：任务完成/归档/删除时对 dsh 会话执行 cancel（不删除 dsh 会话数据）；会话删除仅从 tasks.json 移除关联 + 归档语义照旧。

## 6. 前端（iframe 内）改造清单

| 改动点 | 文件 | 内容 |
|---|---|---|
| API 前缀 | `ui/api.js` | `/api` → `/workbench/api` |
| WS 地址 | `app.js` | `/ws` → `/workbench/ws`（含 wss 判断） |
| 聊天渲染 | `ui/chat.js`（新增）+ `app.js` + `style.css` | dsh 会话在 `#session-terminal` 位置渲染消息流 + 输入框；滚动跟随；流式刷新走现有 SSE→refresh 链路 |
| 会话类型 UI | `app.js`、`index.html` | 新建会话弹层选择 pi/dsh；会话树/看板条目加类型徽标；终端搜索框、主题重启 TUI、复制会话命令等仅对 pi 显示 |
| 主题桥 | `index.html` + `app.js` | 监听 postMessage `{type:'workbench-theme', mode}` 设置显示模式；首帧脚本兼容 |
| 便签发送 | 无前端改动（服务端分流） | — |

约束：保持原生命令式风格与中文文案；改 `app.js`/`style.css` 后同步 `index.html` 的 `?v=` 版本戳。

## 7. 构建与安装接入

1. `scripts/build.mjs`：`packages` 表新增 `workbench-web`（host bundle + tsc 声明；额外把 `public/`、`vendor/` 原地可用，无需打包）与 `client-ui-workbench`（client bundle，external 基线：react/react-dom/cordis/ui-primitives；复用 cssModulePlugin）。
2. `scripts/install-profile.mjs`：按 Host→Client 顺序 remove+add 两个包。
3. `package.json` 的 `files` 覆盖 `public/**`、`vendor/**`（`dsh plugin add ./dir` 走 pnpm 装链）。
4. **node-pty 原生模块**：安装进 profile 时可能需要在 profile 的 `pnpm-workspace.yaml` `allowBuilds` 放行编译；备选方案（若受阻）改用 dsh `ctx.terminals` 承载 PTY（需补回放/输入所有权封装）。

## 8. 里程碑与验证

| 里程碑 | 内容 | 验证 |
|---|---|---|
| M1 Host 骨架 | 包创建、Express+SSE+静态+WS 全部挂上 webServer；pi TUI 可用 | `pnpm run build`；`dsh web` 起后浏览器直开 `/workbench/` 完成任务→会话→TUI 全流程 |
| M2 Client 入口 | 按钮 + 全屏 iframe + 主题桥 | Models 页之外侧栏出现入口；iframe 内主题随 dsh 切换 |
| M3 kind + 数据迁移 | `kind` 迁移、旧数据导入脚本 | 导入后任务/便签/历史会话完整；旧数据文件只读不回写 |
| M4 dsh 桥 + 聊天 | 创建/上下文注入/事件适配/自绘聊天/输入/未读/标题/便签发送 | 一个任务下建 pi+dsh 两会话：列表混排、未读徽标、收藏、重命名、归档恢复、便签发送均工作 |
| M5 收尾 | 并发上限、完成/归档停会话、窄屏与四主题×三模式回归、版本戳 | 手测清单过一遍；`node --check`、tsc、`pnpm run build`、包内 `npm test` 全绿 |

## 9. 风险与备选

| 风险 | 应对 |
|---|---|
| `ctx.sessions` prompt/状态 API 细节与预期不符 | M4 前先写探针插件实测；必要时走 `sessionController` Remote 面 |
| node-pty 编译放行受阻 | 切 `ctx.terminals`（补回放/输入所有权/尺寸同步封装） |
| dsh 会话事件形状与 pi 差异大 | 适配层收敛在 bridge.js 单点；unread.js 依赖的最小接口（消息 id/时间戳/角色/文本）保持同形 |
| 主题检测方式不确定（ui-theme token/class） | 实现时读 `documentElement` 实际 class/`color-scheme`，MutationObserver 兜底 |
| xterm 静态产物版本漂移 | vendor 目录随包固化，升级显式更换 |

## 10. 明确不做（本期）

- 不重写 React 版工作台面板（第二期评估）。
- 不做 dsh 会话的 fork/搜索等宿主高级功能入口（保持工作台自有功能面）。
- 不改动 deepseek-harness 仓库本身；不把服务暴露公网（沿用 loopback）。

## Pi chat display compatibility

The pi chat surface tracks DSH 0.2.0-rc.2 through `dsh-chat-upstream.json`. The blank-session hero uses the native headline and composer geometry with the pi brand; its header, transcript width handles, and statistics dock are hidden until the conversation becomes active. The attachment button is separate from command selection, and command completion accepts Arrow Up/Down, Tab, and Enter.

History follows `leafId` through the pi entries’ `parentId` links. Entries on other branches are excluded; missing parents and cycles fail explicitly. Message usage displays recorded token counts. Adjacent message timestamps are not request or decode timing, so they do not produce duration or tokens-per-second readings.

The context meter opens a panel with pi’s reported token count and model capacity; it supports outside-click and Escape dismissal. System/tool/message breakdowns are omitted without source data.

Native permission/plan controls remain absent without equivalent pi capabilities. The trajectory tab uses the pinned native toolbar, sequence timeline, virtualized table and resizable detail inspector. Turn and assistant/tool groups support folding, search highlighting and linked selection. Thinking and usage belong to their assistant message; tool arguments and results share one record. Pi inline images render from their recorded data URLs. Recorded compactions, branch summaries and model/thinking changes retain their branch anchors. Request prompt internals remain unavailable. Duration controls appear when recorded measurements exist; historical records without measurements or schemas remain unavailable. The local adapter supplies native row types without creating DSH sessions. Local component changes cover inline images, assistant step counts, the timing toggle and source label, copied locale types, the native 36px bottom fade and clearance above the separate pi composer; upstream file hashes track future adaptation work.

### Pi draft lifecycle

The pi brand button and task/sidebar new-session actions open a draft page. Its task picker has independent state from the native DSH task association. Choosing a task, editing text, adding images, and reopening the hero do not create a session. The first nonempty submission allocates a chat session once, then sends the retained text and images after RPC readiness. Repeated clicks are blocked during allocation; allocation errors keep the draft, while prompt failures stay in the allocated session for retry. Existing empty sessions are not deleted automatically.

The conversation and trajectory tabs share the live pi connection. Switching between them does not restart the process. The terminal tab retains the existing RPC/TUI writer exclusion.

Focused checks: `node --experimental-strip-types --test packages/client/ui-workbench/test/*.test.ts`, `node --test packages/task/workbench-web/test/*.test.js`, and the two owner package builds.

## Unified workbench and scheduling

The sidebar has one Workbench entry. Its shared conversation-style header switches between Tasks, Notes, Sessions, Recycle Bin, and Statistics. Existing board filters and actions remain inside their panels; arrow keys and Home/End navigate the header tabs.

Task editing exposes scheduling independently of model settings. Daily, weekly, monthly, and one-time schedules preview their next occurrence through `POST /workbench/api/schedule-preview`, using the same calculation and host timezone as execution. Preview requests do not modify tasks or start sessions. Enabled incomplete schedules and expired one-time dates prevent saving; switching scheduling off permits ordinary task edits. Months without the chosen day are skipped. The server must remain running, and missed occurrences during downtime are not replayed.

Saving locks the form and prevents duplicate submissions. Pi model settings use explicit provider/model input rather than the DSH-only model catalog.

## Pi measurements and view continuity

New chat processes load the bundled pi telemetry extension. It stores `dsh-workbench.telemetry.v1` custom entries, which are not sent to the model. Request duration spans `before_provider_request` through the final assistant message; TTFT ends at the first text, thinking or tool-call delta. Tool duration spans execution start/end, and its parameter Schema is captured at invocation. Run duration spans agent start/end. Durations use the monotonic clock; wall-clock starts locate events on the timeline. These are client-observed event intervals, not provider-internal timings. Abrupt process termination can leave incomplete measurements; older history cannot be retroactively measured. Existing processes need to be stopped and reopened to load the extension.

The native turn usage dialog sums all recorded assistant calls in the user turn and lists their provider/model routes and available cache buckets. The time dialog shows the recorded run duration and first request TTFT. Output speed divides output tokens by the sum of measured decode intervals; missing samples suppress the rate. Historical usage remains available without timing. Measurements follow the active branch and never fall back to adjacent message timestamp differences.

Existing sessions show a loading state until their first history snapshot. Scroll positioning runs before paint; recent sessions retain their own position and loaded-history window while the page remains open. Returning from trajectory preserves the transcript position. Status callback changes do not reconnect the socket; stopping a branch therefore leaves its process stopped until explicitly reopened. Draft and active composers share the DSH width preference. Command-menu anchors are outside the card's flex flow, so the toolbar retains the native 6px bottom padding.
