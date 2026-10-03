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
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  interruptedTurnClosers,
  SessionLogOffset,
  SessionPreparation,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools'
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
  private nativeKernelPresent = false

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
    // Kernel coexistence: the factory slot is single; when the native
    // agent-loop row is enabled (the /kernel switch turned it on) it reliably
    // wins the race (base bundle rows activate first), and this service
    // stands down — keeping only the /kernel command so the switch can be
    // flipped back from within the app. Everything kernel-owned (factory,
    // projections, declarative agents) is claimed inside one effect whose
    // outcome decides the rest of startup.
    ctx.effect(() => {
      let disposeFactory: (() => void) | undefined
      try {
        disposeFactory = ctx.agents.setFactory(this)
      } catch (error: unknown) {
        this.nativeKernelPresent = true
        this.ctx.logger.info('pi-agent: native agent-loop owns the factory — standing down (dsh kernel active)')
        return () => {}
      }
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
      return () => {
        disposeFactory()
        this.accepting = false
      }
    }, 'piAgent.kernel()')
    ctx.commands.register({
      name: 'kernel',
      description: 'Switch the agent kernel for this profile (pi ↔ native dsh)',
      input: { hint: 'pi | dsh' },
      handler: (invocation: CommandInvocation): Promise<CommandResult> => this.switchKernel(invocation),
    })
    const cliEntry = resolvePiCliEntry(config.piCliEntry)
    // Catalog-only adapter: the native model picker lists pi's models.
    // registerAdapter requires at least one route, so registration waits for
    // the offline catalog read (fast, no network). Skipped while the native
    // kernel is active — the native providers own the picker then.
    const adapter = new PiCatalogAdapter({
      catalog: () => this.catalogValue,
      piCliEntry: cliEntry,
      logger: { warn: message => { this.ctx.logger.warn(message) } },
    })
    if (cliEntry !== undefined && !this.nativeKernelPresent) {
      void piCatalog(cliEntry).then(catalog => {
        if (!this.isActive() || this.nativeKernelPresent) return
        this.catalogValue = catalog
        this.adapterHandle = ctx.llm.registerAdapter(catalog.providers, adapter)
      }).catch((error: unknown) => {
        this.ctx.logger.warn(`pi catalog unavailable: ${errorChain(error)}`)
      })
    }
    ctx.effect(() => () => { this.adapterHandle?.() }, 'piAgent.adapter()')

    if (this.nativeKernelPresent) return
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

  private isActive(): boolean {
    return this.accepting
  }

  private static readonly SWITCH_SENTINEL = '# pi-agent kernel switch (managed by /kernel command)'

  /**
   * Flip the profile-level kernel switch by rewriting the sentinel block in
   * the profile's cordis.patch.yml. The patch layering is last-write-wins, so
   * the block overrides the bundle rows; `patchReload: live` picks the change
   * up without a restart (a restart works too). The switched-to kernel takes
   * over on the next session open; the dsh log is shared, so sessions
   * continue across switches.
   */
  private async switchKernel(invocation: CommandInvocation): Promise<CommandResult> {
    const target = invocation.rawInput.trim().toLowerCase()
    if (target !== 'pi' && target !== 'dsh') {
      return { kind: 'error', text: 'usage: /kernel pi or /kernel dsh' }
    }
    // Always rewrite the full block: idempotent, and it repairs blocks
    // written before the model-route flip existed.
    const activeKernel = this.nativeKernelPresent ? 'dsh' : 'pi'
    const profileName = (this.runtime.ctx.get('profileContext') as { name?: string } | undefined)?.name
    if (profileName === undefined || profileName === '') {
      return { kind: 'error', text: 'cannot locate the active profile (profileContext unavailable)' }
    }
    const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
    const patchPath = join(dshHome, 'profiles', profileName, 'cordis.patch.yml')
    let content = ''
    try {
      content = await readFile(patchPath, 'utf8')
    } catch {
      content = ''
    }
    // Strip everything from the sentinel on (the block always lives at EOF).
    const sentinelIndex = content.indexOf(PiAgentLoop.SWITCH_SENTINEL)
    if (sentinelIndex >= 0) content = content.slice(0, sentinelIndex).trimEnd()
    const enableNative = target === 'dsh'
    const block = [
      PiAgentLoop.SWITCH_SENTINEL,
      `# active kernel: ${target} — written ${new Date().toISOString()}`,
      '- id: agent-loop',
      `  disabled: ${!enableNative}`,
      // The default model route is kernel-specific: pi routes come from the
      // pi catalog, native routes from the dsh LLM adapters.
      '- id: agent-default-model',
      '  config:',
      ...(enableNative
        ? ['    provider: deepseek-official', '    model: deepseek-flash']
        : ['    provider: deepseek', '    model: deepseek-flash']),
      '',
    ].join('\n')
    const next = content === '' ? block : `${content.trimEnd()}\n\n${block}\n`
    await writeFile(patchPath, next, 'utf8')
    this.ctx.logger.info(`pi-agent: kernel switch written to ${patchPath} (${target})`)
    const switched = activeKernel !== target
    return {
      kind: 'success',
      text: switched
        ? `Switched to the ${target} kernel. Restart dsh to apply, then reopen the session — history continues from the shared dsh log.`
        : `Already on the ${target} kernel (switch block refreshed).`,
    }
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
      if (machine === undefined) await machineReady.promise
      if (machine !== undefined) {
        machine.cancel({ kind: 'disposed' })
        await machine.whenIdle()
        await machine.disposeDriver()
        detachAgent?.()
        detachSession?.()
        await machine.scope.dispose()
      }
      await handle?.close().catch(() => {})
    })())

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
        detachSession = agent.ctx.sessions.enter(session)
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
