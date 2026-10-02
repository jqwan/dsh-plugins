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

**存储分工（已定）**：会话记录 = dsh v4 格式，`~/.dsh`（原生 UI 的历史/列表/搜索/resume 全靠它）；
pi 模型/认证/设置 = `~/.pi`（pi 进程自读自写）；pi 自己的会话 JSONL 落在插件数据目录
（dsh 日志是事实源，pi 文件仅为驱动 pi 进程所需）。

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

## 7. 命令装配

- 创建 agent 时在 `agent.ctx` 上（per-agent scoped layer）注册 pi 命令集：
  RPC `get_commands` → 每个 `{name, description}` 一个
  `CommandDefinition { name, description, handler: → pi RPC {type:'command', name, args} }`。
  scoped 同名自动遮蔽全局命令。
- 需遮蔽的 dsh 失效命令（permission/goal/plan 等）：同名 scoped 注册礼貌报错版本
  （"由 pi 内核管理"）。实现时对照 `ctx.commands.list(agent)` 实测清单决定。
- 内核无关命令（/export 等）保持全局原生实现，不遮蔽。
- /compact：映射 pi 的 compact RPC（若 v1 无对应命令则先遮蔽）。

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
`@deepseek-ai/dsh-agent-loop`（**仅导入投影定义**）、`@deepseek-ai/dsh-tools`（类型）、
`@earendil-works/pi-coding-agent`（peer，运行时定位 cli.js）。版本精确锁 0.2.0-rc.2。

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
| P5 命令 | get_commands → agent 作用域命令 | 命令进原生补全 | ✅ 已验证（43 条，gentle-shell 全套）；per-agent 遮蔽暂缓（单例 runtime 限制） |
| P6 审批桥 | extension confirm → ApprovalService.request | 原生审批卡片 | ✅ 已接线（无活跃扩展触发，路径按契约实现） |
| P8a 一次性补全 | adapter stream() 经 throwaway pi | stock /compact、LLM 标题可用 | ✅ 已验证（"Compacted 24 history items"） |
| P8b 流式 | message_start/update → assistant-stream 帧 | 原生流式渲染 | ✅ 已接线（协议与原生一致；deepseek-flash 过快未目视确认中间态） |
| P7 subagent | 子会话翻译（pi 侧 gentle-shell 已可用） | 原生面包屑 | ⏭ 下一阶段（工厂侧 parentAgent/meta 管道已就绪） |
| P8c 其余打磨 | steer/inject 映射、compaction 事件映射、失败重试 | 体验接近原生 | ⏭ 后续 |

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
