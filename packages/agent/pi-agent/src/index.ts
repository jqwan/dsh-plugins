/**
 * pi kernel plugin: the concrete AgentFactory that replaces dsh's default
 * agent loop with pi coding agents (one RPC child per session). Structure
 * follows `@deepseek-ai/dsh-agent-loop` (prepare → setup → publish, with
 * rollback on failure); the turn driver is pi instead of the LLM/tool stack.
 *
 * The factory also re-registers the `turnBoundary` and `inbox` projections —
 * the native UI reads them, and the default loop's registrations leave with
 * the disabled row.
 *
 * @module @deepseek-ai/dsh-pi-agent
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
  TurnBoundaryProjection,
} from '@deepseek-ai/dsh-agent'
import { errorChain, type AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import {
  interruptedTurnClosers,
  SessionLogOffset,
  SessionPreparation,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { PiAgent, type PiAgentOptions } from './pi-agent.ts'
import { exportPiSession } from './exporter.ts'

export { exportPiSession }
import { PiCatalogAdapter } from './llm-adapter.ts'
import { piCatalog, resolvePiCliEntry, type PiCatalog } from './catalog.ts'
import { inboxProjectionDefinition } from './inbox.ts'

const turnBoundaryProjectionSchema: zod.ZodType<TurnBoundaryProjection> = zod.object({
  openTurnStartSeq: zod.number().int().nonnegative().transform(SessionSeq).nullable(),
  lastStepStartSeq: zod.number().int().nonnegative().transform(SessionSeq).nullable(),
  lastStepBoundary: zod.object({
    kind: zod.union([zod.literal('start'), zod.literal('end')]),
    seq: zod.number().int().nonnegative().transform(SessionSeq),
  }).nullable(),
  lastTurn: zod.number().int().nonnegative(),
})

/**
 * Host projection of agent turn and step boundaries — byte-compatible with
 * the default loop's definition so the native turn navigator renders
 * pi-driven sessions unchanged.
 */
export const turnBoundaryProjectionDefinition = {
  key: 'turnBoundary',
  stateVersion: 2,
  stateSchema: turnBoundaryProjectionSchema,
  init: () => ({
    openTurnStartSeq: null,
    lastStepStartSeq: null,
    lastStepBoundary: null,
    lastTurn: 0,
  }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return { ...state, openTurnStartSeq: event.seq, lastTurn: event.data.turn }
      case 'turn/end':
        return { ...state, openTurnStartSeq: null }
      case 'step/start':
        return {
          ...state,
          lastStepStartSeq: event.seq,
          lastStepBoundary: { kind: 'start', seq: event.seq },
        }
      case 'step/end':
        return { ...state, lastStepBoundary: { kind: 'end', seq: event.seq } }
      default:
        return state
    }
  },
} satisfies ProjectionDefinition<'turnBoundary', TurnBoundaryProjection>

declare module '@deepseek-ai/cordis' {
  interface Context {
    piAgent: PiAgentLoop
  }
}

/** pi kernel plugin configuration. */
export interface Config {
  /** Root directory for pi session JSONL files; default `$DSH_HOME/pi-agent`. */
  dataDir?: string
  /** pi cli.js absolute path; defaults to the plugin's own pi dependency. */
  piCliEntry?: string
  /** Fallback pi route for agents whose options carry no model. */
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  /** Agents created or resumed at plugin startup (agent-loop config shape). */
  agents: (AgentOptions & {
    /** Stable config label used in logs and as the fresh combined-id prefix. */
    id: string
    /** Optional stable identity for a fresh session. */
    sessionId?: SessionId
    /** Optional workspace for a fresh session. */
    cwd?: string
    /** Persisted session to resume instead of creating fresh. */
    resumeSessionId?: SessionId
    /** pi thinking level for this configured agent. */
    thinkingLevel?: string
  })[]
}

/** Default data root, mirroring the workbench's `$DSH_HOME` fallback. */
export function defaultDataDir(): string {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? join(process.env.DSH_HOME, 'pi-agent')
    : join(homedir(), '.dsh', 'pi-agent')
}

/** One session's owned write handle plus the count of events stored through it. */
interface StoredSession {
  readonly handle: SessionHandle
  storedCount: number
}

/** Prepared-but-unpublished agent resources sharing one memoized teardown. */
interface PreparedAgent {
  agent: PiAgent
  signal: AbortSignal
  publish(source: SessionStartSource): Promise<AgentHandle>
  dispose(): Promise<void>
}

/**
 * Per-process kernel handoff stash, keyed by the root context. When the
 * pi-agent plugin is disabled (Plugins-page row toggle), its teardown loads
 * the REAL AgentLoop plugin on the ROOT scope — a genuine cordis fiber, so
 * service resolution and agent lifecycles work exactly like the stock kernel
 * — and stashes that fiber's disposer here. Re-enabling the plugin runs the
 * disposer first (freeing the slot and sweeping native-era agents through the
 * loop's own FactoryOwnership), then claims the slot back.
 */
const nativeHandoffs = new Map<Context, () => void>()

/**
 * Profile-patch marker written when the pi kernel hands the factory slot to
 * the native agent-loop at runtime (Plugins-page row toggle). The bundle
 * patch hard-disables agent-loop, so a restart with the pi row disabled
 * would boot NO kernel at all; the marker re-enables agent-loop for the
 * next boot. Cleared when the pi kernel constructs again (row re-enabled),
 * restoring the bundle patch's disable.
 */
const HANDOFF_MARKER = '# pi-agent handoff: keep the native agent-loop bootable while pi is off'

export class PiAgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'sessionProjections', 'commands', 'approval', 'tools']

  /** Runtime schema for declarative agents. */
  static Config = z.object({
    dataDir: z.string(),
    piCliEntry: z.string(),
    defaultProvider: z.string(),
    defaultModel: z.string(),
    defaultThinkingLevel: z.string(),
    agents: z.array(z.object({
      id: z.string().required(),
      sessionId: z.string().min(1),
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string().min(1),
      maxTokens: z.number().step(1).min(1),
      cwd: z.string(),
      resumeSessionId: z.string(),
      thinkingLevel: z.string(),
    })).default([]),
  })

  readonly config: Config
  private readonly runtime: { ctx: Context }
  private accepting = true
  private catalogValue: PiCatalog | undefined
  private adapterHandle: AdapterRegistrationHandle | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'piAgent')
    this.config = {
      dataDir: config.dataDir ?? defaultDataDir(),
      ...(config.piCliEntry === undefined ? {} : { piCliEntry: config.piCliEntry }),
      ...(config.defaultProvider === undefined ? {} : { defaultProvider: config.defaultProvider }),
      ...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
      ...(config.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: config.defaultThinkingLevel }),
      agents: config.agents ?? [],
    }
    this.runtime = { ctx }
    // Kernel coexistence: the native AgentLoop kernel is built lazily (see
    // buildNativeKernel) and takes the factory slot when this plugin is
    // disabled from the Plugins page; re-enabling claims the slot back. The
    // dsh log is shared, so sessions continue across switches.
    ctx.effect(() => {
      console.error('[pi-agent] kernel active (factory owned)')
      // Reclaim the slot if a previous pi teardown handed it to the native
      // kernel (plugin toggled off and back on within one process). The
      // native plugin fiber disposes ASYNCHRONOUSLY, so the claim below must
      // wait for the disposal to finish — otherwise setFactory races the
      // freeing of the slot and pi stands down. Its FactoryOwnership sweeps
      // the native-era agents, but their sessions stay mounted under the
      // caller scopes (see publish), so the sidebar keeps every entry.
      const priorHandoff = nativeHandoffs.get(ctx.root)
      if (priorHandoff !== undefined) {
        nativeHandoffs.delete(ctx.root)
        void Promise.resolve(priorHandoff()).then(
          () => this.claimKernel(ctx),
          (error: unknown) => {
            console.error(`[pi-agent] native fiber disposal failed: ${errorChain(error)}`)
            this.claimKernel(ctx)
          },
        )
      } else {
        this.claimKernel(ctx)
      }
      return () => {
        this.factoryDisposer?.()
        this.factoryDisposer = undefined
        this.accepting = false
        console.error(`[pi-agent] kernel teardown (live agents: ${this.liveAgents.size})`)
        // Sweep live agents: their lifecycle fibers belong to the callers'
        // scopes, so the plugin unload alone would leave them (and their pi
        // RPC children) half-orphaned, unable to wake. The sweep stops them
        // cleanly; their sessions stay mounted under the caller scopes (see
        // publish), so no session/disposed fires and the client keeps every
        // sidebar entry. Reopening a swept session resumes it under the
        // current kernel from the shared log.
        const disposals = [...this.liveAgents].map(dispose => dispose().catch((error: unknown) => {
          console.error(`[pi-agent] agent dispose failed: ${errorChain(error)}`)
        }))
        // Live handoff: the Plugins-page toggle disposed this fiber, so load
        // the REAL AgentLoop plugin on the ROOT scope while the slot is free.
        // A genuine cordis fiber resolves services like any host plugin (the
        // hand-built-shim approach died on scope-context service reads).
        try {
          const fiber = ctx.root.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 4 })
          nativeHandoffs.set(ctx.root, () => fiber.dispose())
          Promise.resolve(fiber).catch((error: unknown) => {
            console.error(`[pi-agent] native kernel fiber failed: ${errorChain(error)}`)
          })
          console.error('[pi-agent] native agent-loop plugin loaded on the root scope (plugin disabled)')
          this.ctx.logger.info('pi-agent: factory handed to the native agent-loop (plugin disabled)')
        } catch (error: unknown) {
          console.error(`[pi-agent] native handoff failed: ${errorChain(error)}`)
          this.ctx.logger.warn(`pi-agent: native handoff failed: ${errorChain(error)}`)
        }
        // Persist the handoff: the bundle patch hard-disables agent-loop, so
        // a restart with the pi row still disabled must boot the native
        // loop, not no kernel at all.
        return Promise.allSettled(disposals).then(async () => {
          await this.writeHandoffMarker()
        })
      }
    }, 'piAgent.kernel()')
    const cliEntry = resolvePiCliEntry(config.piCliEntry)
    // Catalog-only adapter: the native model picker lists pi's models.
    // registerAdapter requires at least one route, so registration waits for
    // the offline catalog read (fast, no network).
    const adapter = new PiCatalogAdapter({
      catalog: () => this.catalogValue,
      piCliEntry: cliEntry,
      logger: { warn: message => { this.ctx.logger.warn(message) } },
    })
    if (cliEntry !== undefined) {
      void piCatalog(cliEntry).then(catalog => {
        if (!this.isActive()) return
        this.catalogValue = catalog
        // The model picker follows the kernel: while pi drives, only pi's
        // list is shown. Native routes for ids the pi catalog also carries
        // must leave the registry before this registration (DUPLICATE_ADAPTER
        // otherwise), and the remaining native routes are stashed so the
        // picker shows exactly the list the active kernel can drive.
        this.stashNativeAdapters(adapter, [...catalog.providers])
        this.adapterHandle = ctx.llm.registerAdapter(catalog.providers, adapter)
        this.stashRemainingNativeAdapters(adapter)
      }).catch((error: unknown) => {
        this.ctx.logger.warn(`pi catalog unavailable: ${errorChain(error)}`)
      })
    }
    ctx.effect(() => () => {
      this.adapterHandle?.()
      this.adapterHandle = undefined
      // Kernel handoff: put the native model list back before the native
      // kernel takes over.
      this.restoreNativeAdapters()
    }, 'piAgent.adapter()')
  }

  private isActive(): boolean {
    return this.accepting
  }

  /** Disposer of the factory registration, set once the kernel effect claims the slot. */
  private factoryDisposer: (() => void) | undefined

  /**
   * Native adapter registry entries lifted out of `ctx.llm` while pi drives,
   * restored verbatim at kernel handoff. The llm runtime exposes no public
   * way to withdraw another plugin's registration, so this walks its private
   * adapter map; every access is shape-guarded and degrades to the merged
   * picker list if a dsh upgrade changes the internals.
   */
  private nativeAdapterStash: Array<[string, unknown]> = []

  /** Loosely-typed view of the llm runtime's private registry internals. */
  private llmInternals(): {
    adapters?: Map<string, unknown>
    emitAdaptersUpdated?: () => void
  } | undefined {
    const runtime = this.runtime.ctx.llm as unknown as {
      adapters?: Map<string, unknown>
      emitAdaptersUpdated?: () => void
    }
    return runtime?.adapters instanceof Map ? runtime : undefined
  }

  private emitAdaptersUpdated(): void {
    const runtime = this.llmInternals()
    try {
      runtime?.emitAdaptersUpdated?.()
    } catch (error: unknown) {
      console.error(`[pi-agent] llm/adapters-updated emit failed: ${errorChain(error)}`)
    }
  }

  /**
   * Lift native registry entries for the given provider ids out of the map
   * (making room for this adapter's registration of the same ids), keeping
   * them for {@link restoreNativeAdapters}.
   */
  private stashNativeAdapters(adapter: PiCatalogAdapter, providers: string[]): void {
    const runtime = this.llmInternals()
    if (runtime?.adapters === undefined) return
    for (const provider of providers) {
      const entry = runtime.adapters.get(provider)
      if (entry === undefined) continue
      this.nativeAdapterStash.push([provider, entry])
      runtime.adapters.delete(provider)
    }
    void adapter
  }

  /** Lift every entry not owned by this adapter (the residual native list). */
  private stashRemainingNativeAdapters(adapter: PiCatalogAdapter): void {
    const runtime = this.llmInternals()
    if (runtime?.adapters === undefined) return
    for (const [provider, entry] of [...runtime.adapters]) {
      if ((entry as { adapter?: unknown }).adapter === adapter) continue
      this.nativeAdapterStash.push([provider, entry])
      runtime.adapters.delete(provider)
    }
    this.emitAdaptersUpdated()
  }

  /** Put the stashed native entries back (ids my disposal just freed). */
  private restoreNativeAdapters(): void {
    if (this.nativeAdapterStash.length === 0) return
    const runtime = this.llmInternals()
    if (runtime?.adapters === undefined) {
      this.nativeAdapterStash = []
      return
    }
    for (const [provider, entry] of this.nativeAdapterStash) {
      if (!runtime.adapters.has(provider)) runtime.adapters.set(provider, entry)
    }
    this.nativeAdapterStash = []
    this.emitAdaptersUpdated()
    console.error('[pi-agent] native model list restored (kernel handoff)')
  }

  /**
   * Claim the factory slot and everything kernel-owned that follows from it
   * (projections, declarative agents, the restart marker). Runs after the
   * constructor's effect — synchronously on fresh boot, after the native
   * fiber's async disposal on a same-process reclaim.
   */
  private claimKernel(ctx: Context): void {
    let disposeFactory: (() => void) | undefined
    try {
      disposeFactory = ctx.agents.setFactory(this)
    } catch (error: unknown) {
      // Stand-down: someone else owns the slot — in practice the native
      // loop booted from a stale handoff marker. The marker's job is only
      // to keep a kernel bootable while the row is OFF; with the row ON it
      // would otherwise pin the native kernel across every restart. Drop it
      // so the next boot returns to pi (the running native stays until then).
      console.error(`[pi-agent] claim failed: ${errorChain(error)} — clearing any stale handoff marker`)
      this.ctx.logger.warn('pi-agent: factory slot is taken — pi kernel unavailable this session')
      void this.clearHandoffMarker()
      return
    }
    this.factoryDisposer = disposeFactory
    // Won the slot: pi is the kernel again, so a restart must boot pi —
    // drop the handoff marker that re-enables the native loop.
    void this.clearHandoffMarker()
    // Won the slot: this factory owns the projections too (the native UI
    // reads them; the disabled default loop no longer registers them).
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    ctx.sessionProjections.register(inboxProjectionDefinition)
    for (const { id, sessionId, resumeSessionId, ...options } of this.config.agents) {
      if (resumeSessionId === undefined || resumeSessionId === '') {
        const configuredId = sessionId ?? brandString<SessionId>(`${id}-session-${randomUUID()}`)
        void this.createConfigured(ctx, configuredId, options).catch(
          (error: unknown) => this.reportStartupFailure(id, 'create', configuredId, error),
        )
        continue
      }
      ctx.effect(() => {
        const persistence = this.runtime.ctx.get('sessionPersistence')
        if (persistence === undefined) {
          this.reportStartupFailure(id, 'resume', resumeSessionId, new Error('no session persistence backend'))
          return () => {}
        }
        void this.resumeWith(ctx, persistence, { resumeSessionId, agentOptions: options }).catch(
          (error: unknown) => this.reportStartupFailure(id, 'resume', resumeSessionId, error),
        )
        return () => {}
      }, `piAgent.resume(${id})`)
    }
  }

  /** The active profile's patch file, or undefined when it cannot be resolved. */
  private profilePatchPath(): string | undefined {
    const profileName = (this.runtime.ctx.get('profileContext') as { name?: string } | undefined)?.name
    if (profileName === undefined || profileName === '') return undefined
    const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
    return join(dshHome, 'profiles', profileName, 'cordis.patch.yml')
  }

  private async writeHandoffMarker(): Promise<void> {
    const path = this.profilePatchPath()
    if (path === undefined) {
      console.error('[pi-agent] handoff marker skipped: profile patch path unknown')
      return
    }
    let content = ''
    try {
      content = await readFile(path, 'utf8')
    } catch { /* no patch file yet — create it with the marker */ }
    if (content.includes(HANDOFF_MARKER)) return
    const block = `\n${HANDOFF_MARKER}\n- id: agent-loop\n  disabled: false\n`
    await writeFile(path, `${content.trimEnd()}${block}`, 'utf8')
    console.error(`[pi-agent] handoff marker written to ${path}`)
  }

  private async clearHandoffMarker(): Promise<void> {
    const path = this.profilePatchPath()
    if (path === undefined) return
    let content = ''
    try {
      content = await readFile(path, 'utf8')
    } catch {
      return
    }
    const at = content.indexOf(HANDOFF_MARKER)
    if (at < 0) return
    await writeFile(path, `${content.slice(0, at).trimEnd()}\n`, 'utf8')
    console.error(`[pi-agent] handoff marker cleared from ${path}`)
  }

  private reportStartupFailure(configId: string, action: 'create' | 'resume', sessionId: SessionId, error: unknown): void {
    if (!this.isActive()) return
    this.ctx.logger.warn(`pi agent "${configId}": ${action} of "${sessionId}" failed: ${errorChain(error)}`)
  }

  private async createConfigured(
    ownerCtx: Context,
    sessionId: SessionId,
    options: PiAgentOptions & { cwd?: string },
  ): Promise<Agent> {
    const meta = options.cwd === undefined ? {} : { cwd: options.cwd }
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(sessionId, { meta }))
    try {
      const stored = await this.createStoredSession(preparation.session)
      let prepared: PreparedAgent
      try {
        prepared = this.prepare(ownerCtx, sessionId, options, preparation.session, undefined, stored?.handle, undefined)
      } catch (error: unknown) {
        await stored?.handle.close().catch(() => {})
        throw error
      }
      const handle = await this.initializeAgent(prepared, async () => {
        await this.appendUnstoredSuffix(stored, preparation.session)
        return await prepared.publish('startup')
      })
      return handle.agent
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  /** Factory entry: create one pi-backed agent under a caller-supplied identity. */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    if (!this.isActive()) throw new Error('pi agent factory is not active')
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.meta === undefined ? {} : { meta: options.meta }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    }))
    try {
      const stored = await this.createStoredSession(preparation.session)
      return await this.setupAndPublish(
        ownerCtx,
        options.sessionId,
        preparation,
        this.piOptions(options.agentOptions ?? {}),
        options.setup,
        options.signal,
        'startup',
        stored,
        options.parentAgent,
      )
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  /** Factory entry: resume one persisted session through the pi driver. */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    if (!this.isActive()) throw new Error('pi agent factory is not active')
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: no session persistence backend is mounted')
    }
    return await this.resumeWith(ownerCtx, persistence, options)
  }

  private async resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const id = options.resumeSessionId
    const { preparation, stored } = await this.loadPersisted(persistence, id)
    try {
      return await this.setupAndPublish(
        ownerCtx,
        id,
        preparation,
        this.piOptions(options.agentOptions ?? {}),
        options.setup,
        options.signal,
        'resume',
        stored,
        options.parentAgent,
      )
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  /** Open the write handle, repair an interrupted turn, and prepare the session. */
  private async loadPersisted(
    persistence: SessionPersistence,
    id: SessionId,
  ): Promise<{ preparation: SessionPreparation; stored: StoredSession }> {
    const handle = await persistence.open(id, 'write')
    try {
      const coldRead = await handle.read(0, undefined)
      const persisted = coldRead.events
      const closers = interruptedTurnClosers(persisted)
      if (closers.length > 0) await handle.append(closers)
      const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {
        seed: [...persisted, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      }))
      const stored: StoredSession = { handle, storedCount: persisted.length + closers.length }
      await this.appendUnstoredSuffix(stored, preparation.session)
      return { preparation, stored }
    } catch (error: unknown) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  private piOptions(options: AgentOptions): PiAgentOptions {
    return {
      ...options,
      sessionsDir: this.config.dataDir,
      ...(this.config.piCliEntry === undefined ? {} : { piCliEntry: this.config.piCliEntry }),
      // Route precedence: the caller's selection wins; the configured pi
      // default fills in when the agent carries no model at all.
      ...(options.provider !== undefined && options.model !== undefined ? {} : {
        ...(this.config.defaultProvider === undefined || this.config.defaultModel === undefined ? {} : {
          provider: this.config.defaultProvider,
          model: this.config.defaultModel,
        }),
      }),
      ...((options.provider !== undefined && options.model !== undefined)
        || this.config.defaultProvider !== undefined ? {} : {}),
    }
  }

  private async createStoredSession(session: Session): Promise<StoredSession | undefined> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
    })
    return { handle, storedCount: 0 }
  }

  private async appendUnstoredSuffix(stored: StoredSession | undefined, session: Session): Promise<void> {
    if (stored === undefined) return
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }

  /** Construct the driver agent and one memoized reverse teardown. */
  private prepare(
    ownerCtx: Context,
    id: SessionId,
    options: PiAgentOptions,
    session: Session,
    callerSignal: AbortSignal | undefined,
    handle: SessionHandle | undefined,
    parentAgent: Agent | undefined,
  ): PreparedAgent {
    ownerCtx.fiber.assertActive()
    if (!this.isActive()) throw new Error('pi agent factory is not active')
    const loopCtx = this.runtime.ctx
    const abort = new AbortController()
    const onCallerAbort = (): void => {
      abort.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }))
    }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    const onFactoryTeardown = (): void => { abort.abort(new Error('pi agent factory is not active')) }
    this.teardownSignals.push(onFactoryTeardown)

    let machine: PiAgent | undefined
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    const machineReady = Promise.withResolvers<void>()

    // Reverse teardown: stop the driver, quiesce the machine, unwind the
    // scope, leave the registries, close the owned write handle. Memoized so
    // every racing owner awaits one quiescence.
    const dispose = (): Promise<void> => (disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`))
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.teardownSignals = this.teardownSignals.filter(entry => entry !== onFactoryTeardown)
      this.liveAgents.delete(dispose)
      if (machine === undefined) await machineReady.promise
      if (machine !== undefined) {
        // The inbox port reads the inbox projection, whose registration the
        // fiber teardown may already have unwound (LIFO disposes the
        // projections registered inside this effect before this disposer
        // runs) — dropping pending input is moot at that point anyway.
        try {
          machine.cancel({ kind: 'disposed' })
        } catch (error: unknown) {
          console.error(`[pi-agent] agent dispose: cancel skipped (${errorChain(error)})`)
        }
        await machine.whenIdle()
        await machine.disposeDriver()
        detachAgent?.()
        // detachSession is intentionally NOT called: the session stays
        // mounted under the caller's scope (see publish), so disposing the
        // agent never emits session/disposed and the sidebar keeps the entry.
        await machine.scope.dispose()
      }
      await handle?.close().catch(() => {})
    })())
    this.liveAgents.add(dispose)

    ownerCtx.effect(function* () {
      machine = new PiAgent(loopCtx, id, options, session, loopCtx.commands, loopCtx.get('approval') as ApprovalService, () => loopCtx.tools.schemas())
      machineReady.resolve()
      yield machine.scope.rawDispose
    }, `piAgent.lifecycle(${id})`)
    machineReady.resolve()
    if (machine === undefined) throw new Error(`agent "${id}" lifecycle did not construct its driver`)

    const agent = machine
    const assertLive = (): void => {
      if (abort.signal.aborted) {
        throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason))
      }
    }
    assertLive()

    return {
      agent,
      signal: abort.signal,
      publish: async (source) => {
        assertLive()
        // Mount the session under the CALLER's scope (the session
        // controller's, process-lifetime), not the agent's own scope: an
        // agent dispose (kernel switch, user close) then frees the RPC child
        // and write handle while the session STAYS mounted — no
        // session/disposed, so the client keeps the sidebar entry, and the
        // next open resumes the same mounted session under the current
        // kernel.
        detachSession = ownerCtx.sessions.enter(session)
        detachAgent = loopCtx.agents.enter(agent, parentAgent)
        agent.ctx.sessions.announce(session)
        assertLive()
        await loopCtx.agents.announce(agent, source, abort.signal)
        assertLive()
        return { agent, dispose }
      },
      dispose,
    }
  }

  private teardownSignals: Array<() => void> = []
  /** Memoized dispose of every live agent, swept on plugin teardown (zombie guard). */
  private liveAgents = new Set<() => Promise<void>>()

  /** Wrap prepare + setup + publish with rollback on any failure. */
  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    preparation: SessionPreparation,
    agentOptions: PiAgentOptions,
    setup: AgentSetup | undefined,
    signal: AbortSignal | undefined,
    source: SessionStartSource,
    stored?: StoredSession,
    parentAgent?: Agent,
  ): Promise<AgentHandle> {
    const session = preparation.session
    let prepared: PreparedAgent
    try {
      prepared = this.prepare(ownerCtx, id, agentOptions, session, signal, stored?.handle, parentAgent)
    } catch (error: unknown) {
      await stored?.handle.close().catch(() => {})
      throw error
    }
    try {
      return await prepared.agent.runMaintenance(async () => {
        try {
          const setupCommit = await setup?.(prepared.agent.ctx, prepared.agent)
          setupCommit?.commit()
          await this.appendUnstoredSuffix(stored, session)
          return await prepared.publish(source)
        } catch (error: unknown) {
          prepared.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
          throw error
        }
      })
    } catch (error: unknown) {
      await prepared.dispose().catch(() => {})
      throw error
    }
  }

  private async initializeAgent(prepared: PreparedAgent, initialize: () => Promise<AgentHandle>): Promise<AgentHandle> {
    try {
      return await initialize()
    } catch (error: unknown) {
      await prepared.dispose().catch(() => {})
      throw error
    }
  }
}

export default PiAgentLoop
