# dsh 扩展点清单

> 基于 deepseek-harness 0.2.0-rc.2 源码调研（2026-10-03）。所有路径相对 harness 仓库根。
> 回答三个问题：插件可以**替换**哪些能力、可以**扩展/注入**哪些能力、可以**消费**哪些宿主服务。

dsh 基于 cordis 容器，一切皆插件；组合通过 `cordis.patch.yml` 完成。agent 内核可经
`@deepseek-ai/dsh-agent` 的 `AgentRegistry.setFactory` 替换（默认实现 `@deepseek-ai/dsh-agent-loop`，
见 `packages/core/agent/src/index.ts`）。

---

## 0. 组装语义（一切替换/扩展的基础）

**patch 行结构**（`packages/bundle/base/cordis.patch.yml`）：

```yaml
- insert:
    - id: tool-ralph              # 行 id：跨层覆盖的寻址键
      name: '@deepseek-ai/dsh-tool-ralph'   # npm 包名（插件模块）
      disabled: true              # 可用 !!js 表达式
      config: { subagentProvider: spawn, maxRounds: 64 }
      inject: [webStartup]        # 可选：等某服务存在再激活
```

- base 是对空 profile 根的一次 insert；后续 bundle patch、profile `cordis.patch.yml`、
  `--patch` overlay **按 id 寻址，后写者胜（last-write-wins per row）**。
- **patch 对目标行的 `config` 是整键替换，不是合并**——覆盖时必须重述该行拥有的每一个 key。
- `disabled: true` 的行可被 overlay 以 `disabled: false` 复活。
- 层叠顺序（`packages/boot/app-boot/src/profile.ts`）：profile `package.json` 的
  `dsh.profile.bundles`（有序）→ 每层 `cordis.patch.yml` → profile 自己的
  `$DSH_HOME/profiles/<name>/cordis.patch.yml` → `--patch` overlay。
- patch 类型：`vendor/include/src/index.ts` 的 `applyEntryPatches` / `PatchOptions`；
  匹配不到的 patch 告警跳过；`name` 在 override 行里可作守卫（不匹配则跳过并告警）。
- 插件包声明自己的 patch：`package.json` 加 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。
  官方插件开发技能文档：`packages/preset/agent-preset/skills/cordis-plugin-development/`
  （host-plugin.md / ui-plugin.md / mcp-bundle.md / user-actions.md + templates/decoration、templates/mcp）。

---

## 一、可替换（override 默认实现）

### 1.1 抽象服务缝一览（abstract class Service + base 默认实现行）

| ctx 服务 | 抽象契约 | base 默认实现（行 id → 包） | 仓库内备选 | 契约源码 |
|---|---|---|---|---|
| `ctx.agents`（创建） | `AgentFactory` 经 `setFactory` | `agent-loop` → dsh-agent-loop | — | `packages/core/agent/src/index.ts` |
| `ctx.sessionPersistence` | `SessionPersistence` abstract | `session-persistence-jsonl` → dsh-session-persistence-jsonl | 自写后端 | `packages/session/session-persistence/src/index.ts` |
| `ctx.fs` | `FileSystem` abstract | `fs-sandbox` → dsh-fs-sandbox | dsh-fs-ssh | `packages/fs/fs/src/index.ts` |
| `ctx.sandbox` | `SandboxProvider.confine(argv, policy, signal?)` | `sandbox` → dsh-sandbox-local | -ssh、-windows-acl | `packages/sandbox/sandbox/src/index.ts` |
| `ctx.subprocess` | `SubprocessRuntime` abstract | `subprocess` → dsh-subprocess-local | -ssh | `packages/subprocess/subprocess/src/index.ts` |
| `ctx.shell` | `ShellExecutor` abstract | bash/pwsh × local/sandbox 四组合 | — | `packages/shell/shell/src/index.ts` |
| `ctx.attachments` | `AttachmentStore` abstract | `attachment-local` | — | `packages/attachment/attachment/src/index.ts` |
| `ctx.jobs` | `JobRegistry` abstract | `jobs` → dsh-jobs-local | — | `packages/jobs/jobs/src/index.ts` |
| `ctx.credentials` | `CredentialProvider` abstract | `credentials` → dsh-credentials-local | 自写后端 | `packages/credentials/credentials/src/index.ts` |
| `ctx.compaction` | `CompactionEngine` abstract | `compaction-basic` | 自写 | `packages/compaction/compaction/src/index.ts` |
| `ctx.storage` | hub + backend + domain 三行 | `storage`+`storage-json`+`storage-domain` | dsh-storage-sqlite | `packages/storage/*` |
| `ctx.spill` | spill 缝 | `spill-local` + `spill-policy` | — | `packages/spill/*` |
| `ctx.ptcRuntime` | `PtcRuntime`（ts/python） | `ptc-runtime` → -node | -python | `packages/ptc-runtime/*` |
| 目录选择 | -auto 双面组合 | `directory-picker` → -auto | 直接挂 -native/-browse | `packages/host/directory-picker*` |
| 会话全文搜索 | session-query 开关 | `session-query-sqlite`（默认关） | `openAt`/`path` 覆盖 | `packages/session-query/*` |

**替换写法**（overlay / 插件自身 patch）：

```yaml
- id: session-persistence-jsonl      # 按 base 行 id 寻址
  name: '@local/my-s3-persistence'   # 换实现
  config: { root: !!js dshHomePath('sessions') }   # 整键替换！
# 或仅禁用：
- id: agent-loop
  disabled: true
```

### 1.2 模型适配（可替换 + 可拦截）

- `ctx.llm` 是 `LlmRuntime`（`packages/llm/llm/src/index.ts`）。
- `registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle`；
  handle 有 `replace(providers)` 原子换路。`LlmAdapter` 只需实现
  `abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>`，可选
  `listModels` / `resolveModel` / `prepareCall` / `providerInfo` / `imageRequestPricing`。
- **只注册 listModels/resolveModelInfo 也能闭环模型目录**（catalog 从
  `ctx.llm.listProviders()` + `listModels()` 构建，见 §三）。
- 全局模型调用拦截：waterfall `'llm/stream'(options, next)`——dsh-llm-retry 的实现方式。

### 1.3 presentation / persona（配置级替换）

- `system-prompt` 行：`personaPrefix`/`personaSuffix`/`includeHarnessIdentity`/`includeRuntimeContext`/`toolOrder`；
  scoped 同名 section `deployment:persona-prefix` 可遮蔽部署 persona（"a composition can replace this slot"）。
- `tools` 行 `mode: native|ptc|both`；`approval` 行 `policy: ask|never`；`sandbox-policy` 行 `mode`；
  `permission` 行 presets——全部是 base 行 config 覆盖。

---

## 二、可扩展（新增工具/命令/服务/UI/事件）

### 2.1 工具注册 — `ctx.tools`（dsh-tools，`packages/core/tools/src/index.ts`）

```ts
register(definition: ToolDefinition): () => void          // 全局或 agent.ctx scope
restrict(filter: ToolRestriction): () => void             // 仅 scoped；allow/deny
guard(guard: ToolGuard): () => void                       // 单调拒绝
presentAs(mode: 'native'|'ptc'|'both'): () => void        // 仅 scoped
schemas(scope?): ToolSchema[]                             // 模型可见 schema
```

- `ToolDefinition`：`name`/`description`/`parameters`（JSON Schema）+ **强制**
  `output: { schema, render(args, value), presentationMeta? }` +
  `execute(args, exec: ToolRunContext): Promise<unknown>`，可选 `timeoutMs`、
  `isConcurrencySafe`、`presentCall`、`presentResult`、`projectContent`、`finalizeContent`。
- 辅助构造：`defineTool(options)`（`packages/core/tools/src/schema.ts`）；
  `createMcpToolDefinition(ctx, {...})`（`packages/mcp/mcp-client/src/tools.ts`，MCP 形状捷径）。
- `run_code` 名字保留不可注册；重复注册的报错原文即 per-agent 变体指引：
  "for a per-agent variant, register through that agent's `agent.ctx` instead"。
- 执行管线 waterfall（scope-filtered）：`tools/pre-execute`（allow/deny/cancel/**ask**）
  → `tools/execute`（around）→ `tools/post-execute`；emit `tools/result`、`tools/change`。
- 真实示例：`packages/experimental/browser-use-stagehand-native/src/index.ts`——
  每个方法注册 `stagehand_<method>` 工具 + `ctx.systemPrompt.section(...)` 注入使用指引。

### 2.2 命令注册 — `ctx.commands`（dsh-commands，`packages/interaction/commands/src/index.ts`）

```ts
register(definition: CommandDefinition): () => void
list(agent): readonly CommandDescriptor[]
find(agent, name): CommandDefinition | undefined
execute(agent, line, submittedAttachments, signal): Promise<CommandExecution | undefined>
```

- `CommandDefinition = { definitionId?, name: /^[a-z][a-z0-9_-]*$/, description,
  input?: { hint, attachments? }, recordInput?, handler(invocation): CommandResult }`。
- `CommandDescriptor` = handler-free 视图（`{ definitionId?, name, description, input? }`）供发现 UI。
- per-agent 变体：经该 agent 的 `agent.ctx` 注册 = scoped shadow，同名遮蔽全局定义；
  全局解析顺序 = global 层 + exact scoped shadow。
- 执行落日志：`command/run` → handler → `command/done`（log-only，无 turn 包裹）；
  emit `commands/change`。

### 2.3 System Prompt 注入 — `ctx.systemPrompt`（dsh-system-prompt，`packages/core/system-prompt/src/index.ts`）

```ts
section(section: PromptSection): () => void        // { name, order, text, interpolate?, complete? }
context(context: PromptContext): () => void        // 动态 runtime context
variable(name, provider): () => void               // {{变量}} 模板替换
tools(provider): () => void                        // 动态工具面
suppressRuntimeContext(): () => void
getSectionOrder(name): number                      // 用命名位，别硬编码数字
assemble(context?): Promise<PromptAssembly>
```

- `complete: true` = 整个替换系统提示（多个 complete 共存则装配失败）。
- scoped 同名 section/context/variable 遮蔽全局；waterfall `system-prompt/assemble` 可改写装配结果。

### 2.4 MCP 服务器接入

`packages/preset/agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml`：

```yaml
- insert:
    - id: demo-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: demo
        transport: streamable-http        # 或 stdio + command/args/env/cwd
        url: http://127.0.0.1:3000/mcp
```

工具以 `mcp__<serverName>__<tool>` 命名出现；`ctx.mcpResources` 提供 scoped resource 访问。

### 2.5 会话事件词汇扩展（第三方）

**不能注册进目录，但可安全追加**（`packages/core/session/src/known-event-types.ts` 头注释）：
下游插件事件在目录外 by construction，兼容机制是持久化信封的 `ignorable: true` 标记
（缺它则旧 harness 读到会 fail-closed 拒绝重建）。

- 类型层：`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'my/event': Payload } }`。
- 运行时：`session.append('my/event', data, ...)`；第三方事件**必须带 `ignorable: true`**。
- 格式：`SESSION_FORMAT_VERSION = 4`（`packages/core/session/src/types.ts`）；
  append-only、seq 连续、lossless JSON（BigInt/Date/Map/Set 等在 append 点抛）。
- 已知事件类型 59 种（GENERATED，`scripts/gen-persistence-catalog.ts` 生成 + verify 校验）。

### 2.6 会话投影扩展 — `ctx.sessionProjections`（dsh-session-projection，`packages/session/session-projection/src/index.ts`）

`register<K, S>(definition)` 注册折叠单元（`{ key, stateVersion, stateSchema, init, apply }`），
同 key 不同 `stateVersion` 抛错。已注册 key 示例：`turnBoundary`、`inbox`（agent-loop）、
`userQuestions`（user-questions）、subagent catalog/timing/identity。
这是"新增 session 侧派生视图并推给 UI"的官方通道。

### 2.7 客户端 UI 插件（web/桌面）

**声明**：`package.json` 加 `dsh.client` 段（`platform: 'web'`、`immediately?`、`inject?`、`external?`）
+ `./client` export；入口 `window.__ModuleLoader__.load({ id, factory(require) { return { inject, apply(ctx) } } })`。
React 从模块表 require，不要自带。

**加载机制**：host 侧 `ClientModuleRegistry`（`packages/client/modules/src/index.ts`）扫描激活行
`dsh.client`，合成 `window.__DSH_BOOT__` 模块表，经 `/plugins/<id>/client.js` 服务 bundle。

**Slot 系统**（`packages/client/ui-slots/src/index.ts`）：

- `SlotCore.register(options, component)`；kind：`single`（同格 priority 遮蔽）/`list`（id+order+label）
  /`keyed`（key）/`chain`（select 路由）。scope：`root`/`session-maybe`/`session`。
- `ctx.slots.inject(slotName, fn)` 在其他插件拥有的 slot 里插注册。
- 关键 slot：`sidebar`、`rightbar`（single，占位者 ui-sidebar-right）、`shell.overlay`（**list**，加法席位）、
  `shell.leading`、`sidebar.workspaces`、`sidebar.brand.*`、`sidebar.footer.action`、`sidebar.settings`、
  `conversation.view/content/header*/composer(chain)/composer.bar/dock/input.*/chat.node(keyed)/
  chat.turnTail/chat.assistant-actions/hero.*/approval.detail/trajectory.images/message.images/plan-review.actions`、
  `rightbar.session`、`sidebar.right.pane.tab`（**keyed by tab kind，scope session**，两段式注册：
  类型进 `ctx.sidebarRightTabs` + 组件进 keyed slot）、`sidebar.right.tab.menu.item`、
  `settings.launcher/section/plugins.tab/general.item/models.*`、`plugins.item/detail.*/bundle.*`、
  `tool.call.toolview`（按工具名 keyed）、`tool.call.images`。
- **`root` slot 禁止注册**（single 会整个遮蔽 AppFrame）。
- dockkit（`packages/client/ui-dockkit`）是纯 docking 组件库；tab `kind` 语义由 embedder（ui-sidebar-right）分派。

### 2.8 Subagent 提供方 — `ctx.subagents`（`packages/subagent/subagent/src/index.ts`）

`SubagentRuntime.registerProvider(provider): () => void`（重名抛 `DUPLICATE_PROVIDER`）；
emit `subagent/provider-added`。仓库内 provider：spawn/fork（in-process）、claude-code、codex、acp、dsh-sdk。
选择哪个 provider 是 `tool-subagent` 行 `config.provider`。

### 2.9 其他注册型缝

| 扩展点 | API | 位置 |
|---|---|---|
| Browser-use 提供方 | `ctx.browserUse.register(name)`（单席位） | `packages/browser-use/browser-use/src/index.ts` |
| Computer-use 提供方 | `ctx.computerUse.register(...)` | `packages/computer-use/*` |
| Skill 目录 | `ctx.skills` provider registry | `packages/skill/*` |
| 会话遥测后端 | `SessionTelemetryBackend` | `packages/session/session-telemetry*` |
| LSP | `ctx.lsp` + dsh-lsp-stdio | `packages/lsp/*` |
| Web 搜索提供方 | `web` 行 `searchProvider` | `packages/web/*` |
| Hooks 协议 | dsh-hook-protocol | `packages/hooks/*` |
| 审批应答 | waterfall `approval/request` | `packages/interaction/user-approval` |
| 提问应答 | waterfall `user-questions/request` | `packages/interaction/user-questions` |
| 客户端资源协议 | `ResourceProtocolMap` declare-merge | `packages/client/resources` |
| 客户端 locale | `ctx.locale.register(ns, dict)` | `packages/client/locale` |
| 模型 preset 面 | `ctx.agentPresets`（id/order/plugins + isolate realm） | `packages/preset/*` |

### 2.10 事件系统（消费与互通）

cordis 事件（`ctx.on(name, handler)`；`@mode waterfall` 必须调 `next()`；scope-filtered）：

- 工具：`tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/ptc-dispatch-log`（waterfall），
  `tools/result` / `tools/change`（emit）
- 提示：`system-prompt/assemble`（waterfall）/ `system-prompt/change`
- 模型：`llm/stream`（waterfall）、`llm/adapters-updated`
- Agent：`agent/created`（**serial**：监听器完成后 creation 才 resolve）、`agent/disposed`、
  `agent/status`、`agent/error`、`agent/request`（waterfall）、`agent/request-error`（waterfall）、
  `agent/pre-step`（waterfall）、`agent/assistant-stream`（emit）、`agent/turn-stopping`（serial）、
  `agent/inbox/inserted|claimed|discarded`（emit）
- 会话：`session/event`（每条 session 事件）、`session/created`、`session/disposed`、`session/flush`（parallel）
- 子代理：`subagent/start`、`subagent/end`、`subagent/provider-added`
- 审批/提问：`approval/request`（waterfall，fail-closed `'unavailable'`）、`user-questions/request`（waterfall）
- 命令/UI：`commands/change`、`slots/changed`、`goal/changed`

插件间通信三式：(1) 服务注入（`inject` / `ctx.get`）；(2) 事件；(3) `isolate` 隔离域
（preset 行把服务锁进 realm，跨域寻址用 `serviceForAgent(ctx, agent, name)`，
`packages/preset/agent-preset-registry/src/mount.ts`）。

### 2.11 审批 / 交互链路

1. 工具策略在 `tools/pre-execute` 返回 `{ kind: 'ask', reason?, displayReason? }`；
2. `ApprovalService.request(req)`（要求**有 open turn**）：
   `session.append('approval/asked', { id, toolName, callId?, reason? })`
   → policy `'never'` 直接 `'rejected'`
   → `ctx.waterfall(..., 'approval/request', req, () => 'unavailable')`
   → `session.append('approval/decided', { id, outcome })`。
3. 跨进程：`approval/request` 以 waterfall 中继到 Client（`packages/api/remotes/src/remote-events.ts`）。
4. UI：`ui-approval` `ctx.remote.$on('approval/request')` →
   `ctx.uiSession.registerPendingInteraction(PendingApproval)` → composer 按 pendingInteraction 渲染 ApprovalPanel。
5. resolve：`PendingApproval.answer(outcome: 'allowed-once' | 'rejected')` / `delegate()` / `abort(reason)`。

提问：`ask_user_question` 工具 → `user-questions/request` waterfall；投影键 `userQuestions` =
`{ active: PendingUserQuestion[], settled: SettledUserQuestion[] }`。

---

## 三、可消费（宿主提供的服务，`inject` 即得）

- **Agent/会话**：`ctx.agents`（create/resume/get/list/roots、`requireInitiator()`/`withInitiator()`、
  `setFactory`）、`ctx.sessionPersistence`、`ctx.sessionProjections`、`ctx.sessionProjectionCache`、
  `ctx.sessionQuery`、`ctx.sessionTitle`、`ctx.workspaceRegistry`、`ctx.agentPresets`
- **模型**：`ctx.llm`、`ctx.tokenMeter`、`ctx.agentDefaultModel`（`currentSelection()`/`saveSelection()`）
- **提示/工具/命令**：`ctx.systemPrompt`、`ctx.tools`、`ctx.commands`、`ctx.skills`、`ctx.planMode`、`ctx.goal`
- **执行环境**：`ctx.fs`、`ctx.sandbox`、`ctx.sandboxPolicy`、`ctx.subprocess`、`ctx.shell`、`ctx.shellEnv`、
  `ctx.jobs`、`ctx.ptcRuntime`、`ctx.approval`、`ctx.userQuestions`、`ctx.subagents`、`ctx.permissionPresets`
- **配置/凭据**：`ctx.credentials`（`resolve(ref)` 按 env 名逐次解析、禁缓存）、`ctx.authorization`、
  `ctx.deepseekAccount`、`ctx.settings`、`ctx.configEditor`、`ctx.storage`/`ctx.storageDomain`
- **IO/存储**：`ctx.attachments`、`ctx.spill`、`ctx.compaction`、`ctx.fileReferences`、`ctx.sessionFileReferences`
- **宿主设施**：`ctx.webserver`、`ctx.mcpResources`、`ctx.browserUse`、`ctx.computerUse`、`ctx.otel`、
  `ctx.sessionTelemetry`、`ctx.typert`/`ctx.typertGateway`、`ctx.invariants`、`ctx.pluginManager`、
  `ctx.profileContext`、`ctx.hmr`、`ctx.loader`
- **客户端（浏览器 ctx）**：`ctx.slots`、`ctx.layout`、`ctx.locale`、`ctx.shortcuts`、`ctx.theme`、
  `ctx.sessions`、`ctx.uiSession`、`ctx.resources`、`ctx.connection`、`ctx.remote`、
  `ctx.sidebarRight`、`ctx.sidebarRightTabs`、`ctx.fileUploads`、各 Remote

**host 面 vs preset 面判据**：宿主行 `inject` 一个服务 ⇒ host-plane 所有权（注入先于任何 session）；
preset 子树里的服务在 `isolate` realm，宿主行 inject 不到，只能经持有 agent 的调用方用
`serviceForAgent()` 读。

**模型目录生产者**：`packages/api/session-controller/src/catalog.ts` 的 `buildModelCatalog(ctx,
ctx.agentDefaultModel.currentSelection())`：`ctx.llm.listProviders()` → 每 provider `listModels()` +
`resolveModelInfo()`（取 reasoning efforts）。UI 侧 `ui-model-selection` 经 Remote `session.modelCatalog()` 拉取。
模型选择落会话：`session-controller.selectForNextRequest(agent, selection)` =
`agent.session.append('model/selection', selection)` + 安装 agent-scoped waterfall
（`agent/request` 把 selection 写进 LlmCallConfig；`system-prompt/assemble` 注入 provider/model 变量）。

---

## 四、发现总结

**官方稳定性信号**：
1. `docs/capability-seams.md`（自动生成）把服务分为 "core spine / swappable capability seam /
   bundle composition point / standalone service"——判断可替换性的权威索引。
2. `docs/subsystems/*.md` 每个子系统成对中英文档；`docs/tool-catalog.md`、`docs/persistence-catalog.md` + schema。
3. `packages/preset/agent-preset/skills/cordis-plugin-development/` 官方插件开发技能（含模板）。
4. Service JSDoc 达契约级精度（`ToolDefinition.execute`、`SessionEvent.ignorable`、
   `SessionPersistence` 可见性语义等）。

**事实契约（无正式文档、靠注释与约定）**：
1. patch 覆盖 = 整行 config 替换（只在 patch 头注释）。
2. slot 名与 props 由各 owner 包 `SlotMap` declare-merge 定义，无中央注册表；
   `Slots.listSubTree` / `SlotCore.snapshot()` 运行时检视。
3. host/preset 面所有权判据记录在 web-app patch 注释与 architecture notes。
4. 第三方 session 事件靠 `ignorable: true`（事件名注册被明确否决）。
5. 临时缝：`DSH_TOOLS_MODE` 环境变量（标注 TEMPORARY）。
6. 命令/工具 per-agent 变体机制以报错信息自文档化（cordis scoped context + ScopedLayers）。
7. `user-actions.md` 的"一次实现、两个调用方"（Host 服务 + 命令 + 工具三面同源）是推荐约定。
