# pi-agent 内核插件实现方案

> 2026-10-03 定稿。基于 dsh 0.2.0-rc.2（commit 639ed01）与 pi 0.84.4。
> 前置调研：[dsh 扩展点清单](./dsh-extension-points.md)、[workbench 插件说明](./workbench-plugin.md)。

## 1. 背景与目标

把 dsh 的默认 agent 内核（`@deepseek-ai/dsh-agent-loop`）替换为外部 pi 进程
（`@earendil-works/pi-coding-agent --mode rpc`），dsh 的桌面/Web UI、工具呈现、
会话历史、修改可视化等一切外围能力保持原生不动。

选型依据（维护面最小化）：dsh 核心契约跨 0.1.3→0.2.0 零 diff、事件词汇纯增量；
而 UI 内部漂移巨大（ui-chat 153 文件 +13k 行）。内核替换把适配责任锚定在
"极稳的核心契约 + pi RPC 协议"两点上。

**退役方向**：workbench 的 UI 融合部分（sidebar 接管/overlay/dsh-chat 上游追踪）；
pi RPC 执行器（chat-executor.js）、模型目录映射（model-catalog.js）、telemetry 扩展
迁入新插件复用。

**存储分工（2026-10-04 最终版，方案二）**：dsh 会话日志 = 唯一事实源；pi 会话文件 = 工作缓存
（每次 pi 内核启动从日志无条件重建、dispose 删除，exporter 负责生成）；pi 模型/认证/设置 = `~/.pi`。
内核可经 /kernel 命令在 pi 与原生之间切换，会话跨内核连续。详见 pi-only-persistence-assessment.md 第 9 节。

---

## 2. 架构总览

```
┌─ dsh (cordis, profile web) ────────────────────────────────────┐
│                                                                │
│  原生 UI (ui-chat / ui-conversation / workspace-changes / …)    │
│      ↑ 读投影 (session projections ← 持久化日志)                 │
│      │                                                          │
│  session-persistence-jsonl  ← session/event 自动路由             │
│      ↑ session.append()                                         │
│  ┌──────────────────────────────────────────────┐              │
│  │ PiAgentLoop (Service implements AgentFactory) │ ← setFactory │
│  │   ├─ PiAgent implements Agent                 │              │
│  │   │    ├─ session / inbox / status / ctx      │              │
│  │   │    └─ send/followup/steer/inject/cancel   │              │
│  │   ├─ PiDriver（翻译管道，每 agent 一个 pi RPC 子进程）          │
│  │   └─ pi LLM adapter（仅 catalog，模型选择闭环）                │
│  └──────────────────────────────────────────────┘              │
└──────────────┬─────────────────────────────────────────────────┘
               │ spawn + JSONL RPC (stdin/stdout)
        ┌──────▼──────────────────────────┐
        │ pi --mode rpc --session <file>  │  读 ~/.pi（auth/models/settings）
        │ cwd = 会话工作目录               │  工具执行、审批、compaction 全在 pi 侧
        └─────────────────────────────────┘
```

分工原则：**dsh 只做壳与投影，pi 做一切 agent 行为**。翻译管道是唯一的桥。

---

## 3. dsh 侧契约（实现必须精确遵守）

### 3.1 AgentFactory / AgentHandle（`packages/core/agent/src/index.ts`）

```ts
export interface AgentFactory {
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}
export interface AgentHandle { agent: Agent; dispose(): Promise<void> }
```

- `ownerCtx` 是调用方 context，生命周期必须挂到它（`ownerCtx.effect(...)`），不能挂在
  factory 注册 context 上。
- `CreateAgentOptions`：`{ sessionId, parentAgent?, meta?{cwd?, parentSession?, isSeeded?,
  origin?: 'subagent', delegationDepth?, agentPreset?}, inheritedEventCount?, seed?,
  agentOptions?, signal?, setup? }`。
- `ResumeAgentOptions`：`{ resumeSessionId, parentAgent?, agentOptions?, signal?, setup? }`。

### 3.2 Agent 运行时面（`packages/core/agent/src/runtime-types.ts`）

```ts
interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions      // { provider?, model?, reasoningEffort?, maxTokens? }
  readonly session: Session           // 日志是持久真源
  readonly inbox: Inbox               // 持久 pending work（nextTurn/nextStep/append/splice/...）
  readonly status: 'idle' | 'running'
  readonly ctx: Context               // agent-scoped context
  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void   // 排队但唤醒
}
```

- `AgentCancelCause = { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason } | { kind: 'disposed' }`。
- dispose() 语义：停止 → 等退出 → 反注册 → 从 store 移除 session → 展开 scoped world。

### 3.3 创建/恢复序列（复刻 `packages/core/agent-loop/src/index.ts`）

create：

```
ctx.sessions.prepare(sessionId, { seed?, meta?, inheritedEventCount? })
→ persistence.create(session.header, { inheritedEventCount })     // 认领单写者
→ 构造 agent（session、inbox、driver）并挂 owner effect
→ options.setup?.(agent.ctx, agent) → commit
→ appendUnstoredSuffix（publication 前的 seed 刷进 handle）
→ publish：sessions.enter(session) → agents.enter(agent, parentAgent)
  → sessions.announce(session) → await agents.announce(agent, 'startup', signal)
→ 返回 { agent, dispose }
```

resume（额外步骤）：

```
persistence.open(id, 'write') → handle.read(0)
→ interruptedTurnClosers(persisted) 补合成 closer 并 handle.append(closers)
→ sessions.prepare(id, { seed: [...persisted, ...closers], meta, eventState })
→ 同上 publish 'resume'
```

### 3.4 会话写入规则

- **写会话只用 `session.append(type, data, ...)`**；持久化由后端经 `session/event`
  自动路由，绝不要自己抢 write handle（resume 除外）。
- surface 事件（`user/message`、`assistant/message`、`tool/result`、`system/message`、
  `developer/message`）必须带 `{ surfaceOp: 'append' }`（可附 `sourceEventSeqs`）；
  其余事件**不能带** surfaceOp。
- data 必须 lossless JSON；`Session.seq` 是下一事件序号。
- 事件词汇 59 种在 `packages/core/session/src/known-event-types.ts`（GENERATED）。

### 3.5 投影注册（替换内核后必须补）

`turnBoundary` 与 `inbox` 投影定义由 agent-loop 注册；原生 turn 导航/inbox 面板依赖它们。
**PiAgentLoop 构造器必须重新注册**——定义可直接从 `@deepseek-ai/dsh-agent-loop` 导入
（`turnBoundaryProjectionDefinition`、inbox 投影，`agent-loop/src/index.ts` + `inbox.ts`）。

### 3.6 关键事件 payload（翻译目标 schema）

```ts
'turn/start':  { turn: number }
'turn/end':    { turn: number; reason: TurnEndReason }   // completed | {aborted,reason} | blocked | {error,error:LlmFailure} | max-tokens | interrupted | forked
'step/start':  { turn: number; step: number }
'step/end':    { turn: number; step: number }
'user/message':        UserMessage                          // surface
'assistant/message':   { turn, step, message: AssistantMessage, stream: AssistantStreamRecord[], usage?, interrupted? }  // surface
'tool/call':   { turn, step, callId: ToolCallId, name: string, arguments: string }   // arguments = 模型原文未解析 JSON
'tool/result': { turn, step, message: ToolResultMessage, error?, meta? }             // surface
'request/header': { header: EpochHeader, reason: 'initial'|'resume'|'change'|'series', startsSeries? }
'model/selection': ModelSelection                            // { provider, model, reasoningEffort? } log-only
'approval/asked':  { id, toolName, callId?, reason? }
'approval/decided':{ id, outcome }                            // 'allowed-once'|'rejected'|'cancelled'|'unavailable'
```

消息构造器（`@deepseek-ai/dsh-llm`）：`createUserMessage({ content, source })`、
`createAssistantMessage({ content, source: { provider, model } })`（kind:'model' 自动）、
`createToolResultMessage({ callId, content, isError })`、`createSystemMessage(text)`。

ContentBlock 词汇（merge-extensible，`packages/llm/llm/src/types.ts`）：
`'text'{text}` / `'reasoning'{text}` / `'image'{attachment}` / `'file'` / `'tool-call'{id,name,arguments}`。

TokenUsage：`{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, totalTokens? }`
（inputTokens 是未缓存输入；pi 的 usage 需按此拆分）。

---

## 4. pi 侧接口（协议要点，源自 workbench chat-executor 实测）

- 启动：`node <pi cli.js> --mode rpc --session <file> [--extension <js>] [--provider P --model M]
  [--thinking L] [--no-approve|--approve]`，cwd = 会话工作目录，env 继承。
- stdin JSONL 命令（0.84.4 实测词汇）：`{type:'prompt', message, images?, streamingBehavior:'steer'|'followUp'}`、
  `{type:'steer'|'follow_up', message}`、`{type:'abort'}`、`{type:'clear_queue'}`、
  `{type:'get_state'}`、`{type:'get_entries', since?}`、`{type:'set_model', provider, modelId}`、
  `{type:'get_available_models'}`、`{type:'set_thinking_level', level}`、
  `{type:'get_available_thinking_levels'}`、`{type:'compact', customInstructions?}`、
  `{type:'new_session', parentSession?}`（subagent）、`{type:'get_session_stats'}`、
  `{type:'set_session_name', name}`、`{type:'fork'|'clone'}`、`{type:'get_last_assistant_text'}`、
  `{type:'get_commands'}`（→ `RpcSlashCommand{name, description?, source: extension|prompt|skill}`）。
- `--approve` = projectTrustOverride（项目信任），**不是**工具审批。
- 应答：`{type:'response', command, success, data|error, id}`（按 id 关联，超时兜底）。
- 事件流：`agent_start/agent_end`（turn 边界）、`message_start/message_end/message_update`
  （assistant 消息 + 增量；`assistantMessageEvent` 的 delta 需自行累积：text/thinking 追加、
  toolCall 参数 JSON 累积、toolcall_end 给全量）、`turn_end`、`auto_compaction_*`、
  `extension_ui_request`（select/confirm/input/editor，需回 `extension_ui_response`）。
- usage 在 message_update/message_end 事件携带。
- 模型目录（离 pi 进程独立）：`ModelRuntime.create({allowModelNetwork:false})` +
  `SettingsManager.create(cwd)` → 全量模型快照 + 默认 provider/model/thinkingLevel
  （见 workbench `model-catalog.js`，依赖 `@earendil-works/pi-ai/compat` 的
  `getSupportedThinkingLevels`）。

---

## 5. 事件翻译表（pi → dsh）

| pi 事件/状态 | dsh 会话事件 | 备注 |
|---|---|---|
| prompt 提交（driver 认领 inbox 消息） | `user/message`(surface) + `turn/start` | turn 计数器每会话自增 |
| pi assistant 消息开始 | `step/start {turn, step:k}` + `request/header` | 每 assistant 消息 = 一个 step |
| message_update 增量 | （phase 8）`agent/assistant-stream` cordis 事件喂原生流式 UI | v1 先只落最终消息 |
| message_end（assistant 完整消息） | `assistant/message`(surface) `{turn, step, message, stream:[], usage}` | content blocks 映射见下 |
| 消息内 toolCall 块 | `tool/call {turn, step, callId, name, arguments}` | arguments = pi argsText 原文 |
| pi 工具执行完成（message_update/toolResult） | `tool/result`(surface) `{turn, step, message: ToolResultMessage}` | isError → error 字段 |
| 该消息无 toolCall 且非最后 → 下一 assistant 消息 | `step/end` | step 计数器推进 |
| agent_end / turn_end | `step/end` + `turn/end {reason}` | abort → `{aborted, …}`；错误 → `{error, LlmFailure}` |
| cancel() | pi abort RPC → 上述 aborted 路径 | `keepInbox` 时不清 inbox |
| get_state / message 携带的模型变化 | `model/selection`（log-only） | 与原生 UI 选择共用一条通路 |
| auto_compaction_* | v1 忽略；（后补 `compaction/*` 映射） | dsh 无 compaction 需求（pi 自己管理上下文） |
| extension_ui_request（confirm 等） | 审批链路，见 §8 | |

**content blocks 映射**：pi `text` → `text`；pi `thinking` → `reasoning`；
pi `toolCall{id,name,arguments|argsText}` → `tool-call{id,name,arguments(argsText)}`；
pi `image`（user 侧）→ `image`（attachment 引用需登记 ctx.attachments，v1 仅文本+工具）。

**usage 映射**：pi usage `{input, output, cacheRead, cacheWrite, cost…}` →
`TokenUsage { inputTokens: input, outputTokens: output, cacheReadTokens, cacheWriteTokens }`
（实现时按 pi 实际字段名核对）。

---

## 6. 模型选择闭环（LLM catalog-only adapter）

注册一个只服务目录的 adapter，让原生模型选择器零改动工作：

```ts
const handle = ctx.llm.registerAdapter([], piAdapter)   // 先占位
// 激活时异步拉 pi 目录（ModelRuntime.create allowModelNetwork:false）
handle.replace([...new Set(models.map(m => m.provider))])   // anthropic/openai/...
piAdapter.listModels(provider)   → 该 provider 的 pi 模型
piAdapter.resolveModelInfo(...)   → { reasoningEfforts: getSupportedThinkingLevels(model) }
piAdapter.stream()               → throw（v1；若 session-title-llm 走会话 provider 导致标题失败，再实现 pi 一次性补全）
```

- 好处：ModelSelection `{provider:'anthropic', model:'claude-…'}` 与 pi 的 provider/model
  **1:1 直译**（启动参数 `--provider --model`、运行中 `set_model` RPC）。
- 用户在原生 UI 选模型 → session-controller `selectForNextRequest` →
  `model/selection` 事件 + `installModelSelection` 的 agent-scoped waterfall；
  **PiDriver 监听本会话 `session/event` 的 `model/selection`，调 pi `set_model`**。
- 新会话初始模型：`agentOptions.model ?? pi 默认`；driver 落一条初始 `model/selection`
  事件供 UI 显示。
- `agentDefaultModel` 行 config 可在插件 patch 里覆写为 pi 默认（注意整键替换规则）。

---

## 7. 命令装配（2026-10-04 落定：构造期 + agent scope）

- PiAgent 构造（会话打开）时即 fire-and-forget 注册：`driver.getCommands()`
  （自拉起 pi 进程）→ 每个 `{name, description}` 一个 `CommandDefinition`
  注册到 **`this.ctx.commands`（agent scope）**。打开即显示，无需先对话。
- 注册必须走 agent scope、绝不能走插件根 ctx：根 ctx 的 traceable 代理
  `scopeOf` 为 undefined，注册落入**全局层**——所有会话可见、第二个会话
  起重名注册全部失败、handler 闭包错绑首个会话（跨会话串话）、且与 dsh
  全局 /compact 碰撞。已用真实 cordis/commands 包复现并验证修复。
- scoped 同名自动遮蔽全局命令；注册随 scope 卸载（关会话/关插件）自动
  消失并广播 `commands/change`，客户端目录按会话重拉。
- 需遮蔽的 dsh 失效命令（permission/goal/plan 等）：同名 scoped 注册礼貌
  报错版本（"由 pi 内核管理"）。实现时对照 `ctx.commands.list(agent)` 实测清单决定。
- 内核无关命令（/export 等）保持全局原生实现，不遮蔽。
- /compact：scoped 影子（带 stock definitionId 继承内置脸）映射 pi 的 compact RPC；
  **压缩事件双向落账（2026-10-04）**：pi `compaction_start/end` 帧 → dsh
  `compaction/start` + `compaction/summary` + 表面替换 checkpoint user/message
  （`surfaceOp: replace`，checkpoint source 带 compactionId）+ `compaction/end`——
  原生压缩卡片/usage/锁语义全生效；span 由 dsh 侧选（保护 system 头 + 保留最后一个
  user message 起的尾轮），与 pi 的选择算法不同步（极短会话可能 pi 压了而 dsh 无记录，
  重建后回全长，不丢数据）；exporter 把 `compaction/summary` 映射回 pi `compaction`
  条目（firstKeptEntryId = 阴影范围后首个导出条目）、跳过 checkpoint 用户消息
  （防摘要双份）——压缩跨重启持久，重建保持裁剪形状。

---

## 8. 审批对接（实现期修正）

**实测澄清**：pi 的 `--approve` 只是项目信任覆盖（projectTrustOverride）；pi RPC 模式
**没有工具审批帧**——pi 自身不在 RPC 下做逐工具审批。因此"pi 审批 ↔ dsh 审批"的原设想
调整方向：

1. **extension_ui_request 桥**：pi 扩展生态（gentle-shell 等）通过
   `extension_ui_request(method: 'confirm'|'select'|'input'|'editor')` 向客户端要输入。
   驱动器把这些请求映射到 dsh 原生交互面：
   - `confirm` → `ctx.get('approval').request({agent, toolName, callId?, reason})`
     （原生审批卡片；outcome 'allowed-once'→`{confirmed:true}`、'rejected'→`{confirmed:false}`，
     'cancelled'→`{cancelled:true}`）。前提：open turn 内（driver 持有 turn 期间，天然满足）。
   - `select`/`input`/`editor` → `user-questions/request` waterfall（原生提问卡）或
     `ctx.uiSession` 的 pendingInteraction（P8 酌情，先支持 confirm/select）。
2. **无审批帧的工具调用**直接放行（与 pi TUI 行为一致），tool/call→tool/result 照常落日志。
3. `notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`：记录或转发为
   `system/message`（log-only）或忽略（P8 决定）。

---

## 9. 会话文件与 resume

- pi 会话文件：`<dataDir>/sessions/<sessionId>.jsonl`（dataDir 默认
  `$DSH_HOME/pi-agent`，插件 config 可覆盖）。路径**确定性派生**，无需 sidecar 映射。
- dsh resume：`persistence.open(id,'write')` → 读全量 → `interruptedTurnClosers` 补 closer
  → prepare/enter/announce → driver 用**折叠出的文本历史**重建 pi 上下文：
  - 首选：`--session` 指向原 pi 文件续跑（若 pi 文件与 dsh 日志仍同步）；
  - 兜底：新 pi 进程 + 把 dsh 日志回放的 user/assistant 文本作为种子 prompt 前缀
    （最简 resume，v1 先做兜底路径，确认 pi 文件可靠后再切主路径）。
- turn 计数器在 resume 时从折叠状态恢复（turnBoundary 投影的 lastTurn）。

---

## 10. subagent（后期阶段）

- pi 侧 delegate 工具（自写 extension，参考 gentle-shell 形态）起子 pi 进程；
- 翻译层用 `createAgent({ parentAgent, meta: { parentSession, origin:'subagent',
  delegationDepth } })` 建子会话 → 原生 subagent 面包屑/轨迹自动展示；
- 子 agent 的 driver 是同一 PiAgentLoop，无特殊路径。

---

## 11. 包结构与装配

```
packages/agent/pi-agent/
  package.json          # name: @deepseek-ai/dsh-pi-agent; dsh.bundle.patch → ./cordis.patch.yml
  cordis.patch.yml      # - id: agent-loop / disabled: true
                        # - insert: [{ id: pi-agent-loop, name: '@deepseek-ai/dsh-pi-agent', config: {...} }]
  tsconfig.json
  src/
    index.ts            # PiAgentLoop extends Service implements AgentFactory（插件入口）
    agent.ts            # PiAgent implements Agent（inbox/status/驱动接口面）
    driver.ts           # PiDriver：pi RPC 子进程管理 + 事件翻译管道
    rpc.js              # pi RPC 客户端（改造自 workbench chat-executor.js：行分帧/增量还原/命令关联）
    catalog.js          # pi 模型目录（改造自 model-catalog.js）
    events.ts           # pi 帧 → dsh 会话事件翻译器（纯函数，可单测）
  test/                 # events 翻译单测（fixture 帧 → 期望事件序列）
```

依赖：`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、
`@deepseek-ai/dsh-agent-loop`（**仅导入投影定义**）、`@deepseek-ai/dsh-tools`（类型）。
pi 不再是依赖（见 15.3）。版本精确锁 0.2.0-rc.2。

插件 config：`{ dataDir?, piCliEntry?, defaultProvider?, defaultModel?, approve?: boolean }`。

安装：`scripts/install-profile.mjs` 增加 `piAgent` 包；`dsh plugin --profile web add <abs>`。
补丁生效链：包自身 cordis.patch.yml 的 `disabled: agent-loop` 行在 profile 层后写获胜。

---

## 12. 分阶段实施

| 阶段 | 内容 | 验收 | 状态（2026-10-03） |
|---|---|---|---|
| P0 骨架 | 包/patch/config；PiAgentLoop 激活并 setFactory；投影注册 | dsh 起得来、原生 UI 出新会话 | ✅ 已验证 |
| P1 文本探针 | driver 拉起 pi；send→prompt→assistant/message 落日志 | 原生聊天看到 pi 回复 | ✅ 已验证（"收到"） |
| P2 全事件 | step 边界、tool/call、tool/result、usage、turn/end reason | 轨迹/用量原生呈现 | ✅ 已验证（ls 6t7s、41.5K tok、cache 66%） |
| P2 补充 | cancel→abort | Stopped 状态、中断内容保留、会话可用 | ✅ 已验证 |
| P3 模型闭环 | catalog adapter；UI 选模型→set_model；路由过滤 | 选择器列出 pi 模型并切换 | ✅ 已验证（DeepSeek 组出现） |
| P4 resume | interrupted closers；pi 会话文件续跑 | 重启后带全上下文继续 | ✅ 已验证（缓存命中 74%） |
| P5 命令 | get_commands → agent scope 命令（构造期注册） | 打开会话即显示 pi 命令；/compact 影子生效 | ✅ 已验证（43 条，gentle-shell 全套）；2026-10-04 修正为 agent scope 注册（全局层路径有跨会话串话/重名碰撞，已复现并修复） |
| P6 审批桥 | extension confirm → ApprovalService.request | 原生审批卡片 | ✅ 已接线（无活跃扩展触发，路径按契约实现） |
| P8a 一次性补全 | adapter stream() 经 throwaway pi | stock /compact、LLM 标题可用 | ✅ 已验证（"Compacted 24 history items"） |
| P8b 流式 | message_start/update → assistant-stream 帧 | 原生流式渲染 | ✅ 已接线（协议与原生一致；deepseek-flash 过快未目视确认中间态） |
| P7 subagent | 子会话翻译（pi 侧 gentle-shell 已可用） | 原生面包屑 | ⏭ 下一阶段（工厂侧 parentAgent/meta 管道已就绪） |
| P8c 打磨 | compaction 事件映射 ✅（2026-10-04：帧→dsh 压缩词汇 + exporter 回映，压缩卡片/持久化生效）；steer/inject 映射 | 体验接近原生 | ⏭ 余项 |

每阶段独立提交；P1 完成即架构验证通过。

---

## 13. 风险与开放问题

1. **日志 schema 严格**：写错条目投影崩——events.ts 纯函数 + fixture 单测覆盖所有翻译路径。
2. **AssistantStreamRecord/stream 字段**：v1 传 `[]`（流式记录可选时）或最小 record；
   实现时核对 agent-loop 实际写入形状。
3. **session-title-llm** 若走会话 provider 调 ctx.llm.stream，需要 pi 一次性补全 adapter
   （P8 决定）。
4. **pi 审批帧形态**待实现时确认（extension_ui_request vs 专用帧）。
5. **steer 语义差**：dsh steer=下个 step 边界消费；pi steer=打断当前流。v1 用 pi 原生
   streamingBehavior:'steer'（体验优先于严格语义）。
6. **inject 无 pi 对应物**：缓存到下一 prompt 前缀（P8）。
7. **AgentFactory 无成文稳定性承诺**（0.2.0-rc 事实契约）——接受；适配面已量化为最小。
8. **pi usage 字段名**实现时核对（input/output vs inputTokens/outputTokens；cost 不映射）。

---

## 14. 内核切换（重启式，已实测）

入口：插件页 → `@deepseek-ai/dsh-pi-agent` 详情页 → 「组件」行开关
（`setPluginEnabled` → 写 profile patch 行 `- id: pi-agent disabled: …` → 热 reconcile）。
外层「包」开关是安装/卸载语义，切换内核一律用行开关。

**方向定案（2026-10-04）：关闭即时生效，开启重启生效。** 运行时双向热切换
（字段抢槽 + marker 清除 + 热调和）被证伪：① dsh 的 HMR 服务监听 profile
patch 文件（`hmr.watchConfig → refresh → reconcileProfilePatches`），任何
文件与运行行状态的偏差都会被下一次 reload「纠正」——接管后清 marker 必然
触发原生行停用，其 `setFactory` disposer 会连带清掉 pi 抢来的槽位（
"no agent factory registered"）并把它挂在 agent 作用域上的会话拖出侧边栏；
② 行激活顺序不保证，marker 引导的原生行是 required 插件，pi 抢先认领会
直接 abort 整个启动；③ 原生会话挂载在 agent 作用域（`agent.ctx.sessions.enter`），
任何原生行停用都掉侧边栏——上游设计，插件侧只能收养缓解。

### 14.1 机制（pi-agent/src/index.ts）

- **关闭（pi → 原生，即时）**：kernel effect disposer 里 ① `disposeFactory()`
  释放槽位；② 清算 `liveAgents`（防僵尸 pi 进程）；③ **卸载追踪的会话并回填
  侧边栏**（`unmountTrackedSessions`：卸载前抓 summary 快照——header + 活投影
  `cachedSnapshot`——→ `detach()` 触发 `session/disposed` → controller 广播
  removed → 立即补发 `api-session/added` 带快照，客户端重新加行；store 释放
  id，原生内核得以**冷恢复**这些会话而不是撞 id 唯一性）；④ 写「交接标记」
  （`- id: agent-loop disabled: false`）；⑤ deferred 80ms 热调和 → loader
  激活原生行 → 原生 `setFactory` 认领。内核不中断，新旧会话都即刻可用。
- **开启（原生 → pi）**：
  - 无标记（正常 pi 启动）：构造期直接 `setFactory` 认领。
  - 有标记 + 启动期（uptime < 20s）：**绝不立即认领**——marker 引导的原生行
    是同轮 loader 的 required 插件，抢跑会 abort 启动。deferred 到
    `loader.await()` 之后：原生行已干净认领 → boot 接管（清 marker → 热调和
    退役原生行 → pi 认领 freed 槽位），一次重启完成切换。接管窗口用
    `switching` + root 级 `session/disposed` 观察者**收养**被退役行孤儿化的
    会话（重新 enter+announce 并入 `sessionMounts` 追踪，客户端
    removed→added，行不丢）。
  - 有标记 + 运行中开启（uptime ≥ 20s）：**惰性**——保留 marker（文件继续
    如实描述运行中的原生行，HMR 不会动手），日志提示「重启 dsh 切换到 pi」。
    下次重启走上面的 boot 接管。
- **标记的意义**：bundle patch 硬禁用了 agent-loop；行开关关闭状态下重启
  dsh 时，pi 行不加载、agent-loop 又被禁 → 无内核死态。标记让这次重启启动
  原生内核。pi 认领成功后清除标记，恢复 bundle 语义。
- **模型列表跟随内核**：pi 目录 adapter 只在真正拥有槽位时注册
  （`kernelOwned` 门控）；惰性 pi 保持原生列表。
- **会话挂载追踪（`sessionMounts`）**：pi 发布的会话与收养的原生会话都记
  `{ session, detach }`。单个 agent 正常 dispose **不**卸载（侧边栏保行）；
  只有 kernel teardown 统一卸载。发布失败的回滚在 agent dispose 里静默
  detach（未 announce，无广播）。

### 14.2 状态矩阵（实测）

| 操作 | 结果 |
|---|---|
| pi 开机自启（无标记） | pi 认领，pi 内核 |
| 行开关关闭（运行中） | 原生行热激活接管；会话卸载+行回填，侧边栏稳定；**新旧会话原生下均可冷恢复续聊** |
| 行开关开启（运行中，原生服役） | pi 惰性 + 保留标记，原生继续服务，侧边栏稳定 |
| 关闭后重启（有标记） | 原生认领，pi 行不加载 |
| 开启后重启（有标记） | 原生先认领（required），pi deferred boot 接管，一次重启完成 |

### 14.3 已知边界

- **跨内核 resume 已修**（卸载+回填方案，2026-10-04）：关闭插件即卸载全部
  追踪会话并补发 added，原生内核对 pi 生代会话走冷恢复（`resumeWith` 的活
  会话复用路径保留给收养场景：boot 接管后收养的会话仍挂载，pi 直接围绕它
  重建驱动）。
- 切换瞬间**打开中的会话视图**仍需重开（agent 随切换退役，客户端 live 绑定
  断开，composer 显示 unavailable）；侧边栏行不丢，重开即冷恢复，历史无损。
- boot 接管窗口（启动后数秒）与客户端自动重开竞速：若客户端在原生行存活的
  窗口内 resume 了会话，接管时由收养观察者保行；该会话的打开视图仍需重开。
- 补发的 `api-session/added` 是 session-controller 的内部远程事件，summary
  形状（header 字段 + `cachedSnapshot` 投影块）属于 dsh 实现细节——dsh 升级
  若改 summary/投影 wire 格式，这里要跟一次（`captureSidebarSummary` 单点）。
- 切换后模型/命令列表按当前内核展示；`/goal` 等原生命令在 pi 下仍是空转
  （待 pi extension 桥接，未实施）。

### 14.4 会话格式：受保护 system 头（已修复，af87a84）

v4 格式要求日志**第一条 surface 事件**是 `system/message`（受保护头）。pi 工厂建会话不写头，
原生内核 resume 这种无头会话时会把自己的 system/message 追加在中段——永久格式违规，pi 再
resume 即报 `system/message requires a protected first surface head`（用户复现：pi 建 → 切
原生发 → 切回 pi resume 失败）。

修复：pi 首个 open step 内（step/start 之后、user/message 之前）种受保护头（原生记录形状：
role/content/source kind system-prompt/surfaceOp append）；此后原生 resume 走合法的
「替换头」操作而非非法追加。两个边界：
- 修复前已存在的无头会话**不能**事后补头（追加即违规），保持 pi-only；被原生污染过的日志
  可离线修复（剔除中段 system/message 后重压缩）。
- resume 失败会把会话从 workspace.json 的 sessionIds 索引移除（侧栏消失）；修复文件后需
  手工把 session id 加回对应工作区的索引。侧栏列表来自该显式索引，不是目录扫描。

---

## 15. 通用工具桥（**MCP 路线**，2026-10-05 定稿）

**演进**：初版 = 自定义 pi 扩展（进程内 jiti 加载）+ 自定义 socket 协议。0.84/0.85 上扩展
从未在用户环境成功连上（疑似 jiti/扩展加载缺陷，且存在约 30-60 分钟的间歇性启动挂死窗口——
所有 pi rpc 启动都挂、含无扩展场景、自恢复、未定位，见 15.2）。**现版（MCP 路线）把 pi 侧
脆弱的进程内扩展整体移除**，改用 pi 1.0.x 内置 MCP 客户端 + 零依赖 MCP shim：

```
pi 模型 → pi 内置 MCP 客户端（官方维护）→ MCP shim（stdio，零依赖，回调状态机）
  → unix socket（env DSH_TOOL_BRIDGE_SOCKET 继承自 pi 进程）→ ToolBridgeServer（不变）
  → ctx.tools.execute({agent: PiAgent}) → 原生审批/沙箱/权限 → 结果经 MCP 返回
```

- **shim**（`bridge/dsh-mcp-shim.mjs`，随包分发 `lib/bridge/`）：MCP stdio 服务器，实现
  initialize（回显客户端版本）/tools/list（dsh schema 直作 inputSchema）/tools/call（失败
  映射 isError 结果，注册表抛错同）/notifications/cancelled（→ socket cancel → AbortController）。
  **纯回调状态机，无 async/await**——排查中发现 promise 链在 socket 回调 + resolve 交互下
  会进入微任务饥饿式自旋（99% CPU、事件循环停止调度新回调，未定位到根因，回调式绕开）。
  无 socket env（用户直跑 pi）时工具列表为空，完全惰性。
- **配置**：插件构造时（gate on）幂等写 `~/.pi/agent/mcp.json` 的 `dsh-tools` 条目
  （`{command: node, args: [shim]}`），保留用户其他服务器。
- **socket 协议与 ToolBridgeServer 完全不变**（list/execute/cancel 帧、per-PiAgent socket、
  disposeDriver 清算）。
- **门控**：默认开，`DSH_PI_TOOL_BRIDGE=0` 可关（2026-10-06 翻转；原默认关是挂死窗口
  时代的保守决定，窗口已证实为环境级且与桥无因果）——gate 同时控制 ①插件启动时写
  mcp.json 配置 ②driver 向 pi 进程注入 socket env。gate 关 = 无配置无注入 = 桥完全不存在。
- **证据**：shim 协议 smoke 全绿（initialize/list/call/isError 映射/取消中继）；真 pi 1.0.2
  e2e 全绿（内置 MCP 客户端 spawn shim → 模型调用 mcp__dsh_tools__dsh_echo → 宿主以正确
  agent 归因执行 → 结果回填 → agent_end）。
- 工具命名：`mcp__dsh-tools__<toolname>`（pi 对 MCP 工具加服务器前缀）。隔离 agent 目录测试
  用 `PI_CODING_AGENT_DIR` env（getAgentDir 的覆盖点）。
- **归因修复（2026-10-05 用户实测反馈后）**：桥执行包 `agents.withInitiator(agent, …)`——
  goal 工具的守卫读 `agents.currentInitiator()`（AsyncLocalStorage），原生内核里工具调用在
  driver 续体内所以满足，socket 回调是新异步上下文必须显式重建边界；subagent fork 报
  "systemPrompt without inject" = PiAgent scope 链缺 inject 声明，inject 补
  systemPrompt/agentPresets/subagents（均在 base/web-app 组合中常驻）。
- **日志格式污染修复（同日第二轮实测）**：pi 的 codemode 内置扩展会把工具调用扇出成嵌套
  子派发（toolCallId `parent/1`），translator 原样入账 → v4 校验器拒载（嵌套 tool/call
  需要"已宣告"的复合生命周期，pi 帧不带）。修复：translator 跳过 callId 含 `/` 的
  tool_execution_start/end 帧（父子成对跳过保持配平；父级结果已含嵌套输出）。已损坏日志
  离线修复法：zstd 解压 → 过滤 callId/toolCallId 含 `/` 的 tool/call+tool/result 对 →
  重压缩（本次 11 对，备份留存）。
- **pre-step 生命周期补齐（同日）**：子 agent 的 durable descriptor 由 in-process driver
  挂在子 agent 的 `agent/pre-step` 瀑布上，PiAgent 从不发射 → 子会话永远没有
  `subagent/descriptor` → 打开子会话报 "descriptor is corrupt"（投影把"无描述符"折叠为
  null）。修复：PiAgent.turn 在 step/start 后按原生语义发射 pre-step 瀑布（默认
  enter+claimed；reject 视为空转结束）。

**15.2 pi 升级 1.0.2（2026-10-05）**：依赖 ^0.84.4 → ^1.0.2（0.86/0.87/0.99/1.0 跨越），
构建零错误，RPC 协议面未变。1.0.2 改善：桥扩展在用户环境**能连上宿主**了（0.84 从未连上）；
健康窗口内全场景（桥+resume+prompt→agent_end）可过。**未解之谜——间歇性启动挂死窗口**：
约 30-60 分钟的时段内**所有** pi rpc 启动都挂（含无扩展的 fresh/resume），自恢复；挂死期
无任何网络连接（preload 抓证）、主线程空转 processTimers、Startup Timings 显示 main() 30ms
跑完后无输出（挂点在 runRpcMode 内部 await）；对 inspector 信号/CDP pause 也无响应。
怀疑环境级（代理/文件锁/系统态），无法复现定位。桥默认关闭的决定维持：挂死影响所有启动
路径，与桥无因果（无扩展也挂）；窗口机制查明后再评估默认开启。

**15.3 pi 收敛为全局唯一安装（2026-10-06）**：用户决策"机器上只有一份 pi、跟随全局升级"。
`resolvePiCliEntry` 解析顺序改为 **显式 piCliEntry → 运行中 node 的 npm -g 安装
（`<prefix>/lib/node_modules/...`，nvm 下随 node 版本切换自动跟随）→ 插件依赖（兜底，
兼容他人环境）**；插件 package.json 移除 `@earendil-works/pi-coding-agent` 依赖，
`piCatalog` 的 SDK 读取从同一 cliEntry 派生（spawn 的 CLI 与进程内 SDK 天然同版）。
`resolvePiCliEntry`/`piCatalog` 从包入口导出作诊断面。全局升级后无版本闸门——大版本
跳跃时先跑一次真实会话（RPC get_state + 一轮 prompt→agent_end）再重启 dsh。已验证：
全局 1.0.3 解析/SDK/RPC 握手全绿。


目标：让 pi 内核用上 dsh 注册表的**全部**工具（subagent/goal/bash/web/…含未来插件工具），
不做逐个适配。两个进程内组件经私有 unix-socket JSONL 通道协作：

- **宿主侧 `ToolBridgeServer`**（`src/bridge.ts`，per-PiAgent 一个）：监听
  `~/.dsh/pi-agent/<id>.bridge.sock`；`list` 回 agent 作用域 wire schemas（与请求锚点同源）；
  `execute` 转 `ctx.tools.execute({name, arguments, agent: PiAgent, signal})`——agent 自填
  （ToolExecutionInput.agent 本就是调用方填的），审批卡片/权限/沙箱全走原生管线；`cancel`
  映射 AbortController；连接断开即清算在途调用；disposeDriver 兜底 stop。
- **pi 侧 `bridge/pi-dsh-bridge.mjs`**（零依赖扩展，async 工厂）：读 env
  `DSH_TOOL_BRIDGE_SOCKET` → 连接 → 拉 schemas → `pi.registerTool`（dsh JSON Schema 直接
  作 TypeBox 参数——pi 对无 Kind 符号的纯 JSON Schema 有专门兼容分支）→ execute 转发 +
  signal abort → `cancel` 帧。桥故障 = 工具缺失，会话其余功能不受影响（优雅降级）。
- （历史，已废弃）初版扩展路线的接线：spawn 时 `--extension <file>` + env 注入；pi loader
  对 --extension 要求文件而非目录、目录内每个文件都会被当扩展加载、`--extensions` 复数是
  update 子命令专属。被 MCP 路线取代后，旧扩展文件与 --extension 注入均已删除。

已知边界：工具清单在扩展加载时快照（`tools/change` 动态同步未做）；结果只取 text 块
（图片降级占位）；`tools.execute` 抛错映射为 pi 工具失败文本。实测要点：pi 会话发消息让它
调 `dsh_read_file`（或任一 dsh 工具名）→ 原生审批卡片 → 批准 → 结果回填。
