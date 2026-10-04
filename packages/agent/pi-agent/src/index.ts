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
import { readFileSync } from 'node:fs'
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
import { readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
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
    // Kernel coexistence: the native AgentLoop kernel row owns the factory
    // slot whenever this plugin is disabled (the handoff marker boots it);
    // disabling pi hands the kernel over LIVE, enabling pi takes effect on
    // the next dsh restart (see claimKernel).
    // Switch-window adoption: retiring the native kernel row disposes its
    // agents, and those agents' scopes carry their sessions' list mounts
    // (the native loop enters sessions under agent.ctx) — every orphaned
    // session would emit session/disposed and drop out of the open
    // sidebars. While a switch is retiring that row (the boot takeover is
    // the only such path), re-enter each orphaned session under the
    // process-lifetime carrier and re-announce it: the client sees
    // removed→added and keeps every row. Registered at the root because
    // scoped dispatch matches listeners against the dying agent's ancestor
    // scopes, which excludes this plugin's own context. The disposer runs in
    // the kernel teardown below.
    const detachAdoption = ctx.root.on('session/disposed', (session: Session) => {
      this.adoptOrphanedSession(session)
    })
    const teardownKernel = (): (() => void) => () => {
      detachAdoption()
      this.factoryDisposer?.()
      this.factoryDisposer = undefined
      this.accepting = false
      console.error(`[pi-agent] kernel teardown (live agents: ${this.liveAgents.size})`)
      // Sweep live agents: their lifecycle fibers belong to the callers'
      // scopes, so the plugin unload alone would leave them (and their pi
      // RPC children) half-orphaned, unable to wake. The sweep stops them
      // cleanly.
      const disposals = [...this.liveAgents].map(dispose => dispose().catch((error: unknown) => {
        console.error(`[pi-agent] agent dispose failed: ${errorChain(error)}`)
      }))
      // Live handoff, single activation path: write the marker that
      // re-enables the agent-loop row, then run one hot reconcile so the
      // LOADER activates that row as the native kernel (a real host fiber,
      // owning the service and the slot). Every later toggle leaves the
      // row byte-identical, so no reconcile ever re-activates or collides
      // with it again. Loading a private AgentLoop fiber here instead
      // collided with the marker-driven row activation on re-enable.
      // The reconcile itself must run OUTSIDE the disposer: it waits for
      // every row fiber it manages to finish disposing — including THIS
      // one — so calling it synchronously here deadlocks on itself.
      return Promise.allSettled(disposals).then(async () => {
        // Unmount our sessions AFTER the agents are gone (their final events
        // and projection state are settled) and hand the sidebar rows back
        // to the client as cold entries. The freed ids let the native kernel
        // cold-resume these sessions from the shared log instead of
        // colliding with the store's id uniqueness.
        this.unmountTrackedSessions()
        await this.writeHandoffMarker()
        setTimeout(() => { void this.activateNativeKernelRow(ctx) }, 80)
      })
    }
    ctx.effect(() => {
      // The marker means the native row was (re-)enabled for a pi-off
      // period. Distinguish the two ways pi can construct under it:
      //   - During the startup loader pass (uptime is seconds): the marker
      //     booted the native row as a REQUIRED plugin of this very pass.
      //     Claiming synchronously could win the race (row activation order
      //     is not guaranteed) and fail that row's mandatory claim,
      //     aborting the whole startup. Defer past the pass; the native row
      //     claims first, then deferredClaim retires it (no native session
      //     is meaningfully open this early) and pi claims — the switch the
      //     user asked for completes without a second restart.
      //   - A live enable after an in-process disable (uptime is minutes):
      //     the marker describes the RUNNING native row. Takeover would
      //     retire it and drop the sessions its clients have open, so stay
      //     inert and keep the file as-is; the next restart takes the
      //     deferred path above.
      if (this.hasHandoffMarker() && process.uptime() < 20) {
        setTimeout(() => { void this.deferredClaim(ctx) }, 0)
        return teardownKernel()
      }
      console.error('[pi-agent] kernel active (factory owned)')
      this.claimKernel(ctx)
      return teardownKernel()
    }, 'piAgent.kernel()')
    const cliEntry = resolvePiCliEntry(config.piCliEntry)
    // Catalog-only adapter: the native model picker lists pi's models.
    // registerAdapter requires at least one route, so registration waits for
    // the offline catalog read (fast, no network) AND for this kernel to
    // actually own the factory slot — an inert pi (native kernel serving)
    // must keep the native picker list.
    const adapter = new PiCatalogAdapter({
      catalog: () => this.catalogValue,
      piCliEntry: cliEntry,
      logger: { warn: message => { this.ctx.logger.warn(message) } },
    })
    if (cliEntry !== undefined) {
      this.adapterRegistration = { adapter, ctx }
      void piCatalog(cliEntry).then(catalog => {
        if (!this.isActive()) return
        this.catalogValue = catalog
        this.maybeRegisterModelAdapter()
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

  /** True once this kernel owns the factory slot (a live claim or a boot takeover). */
  private kernelOwned = false
  /** Adapter + context for the deferred model-picker registration (see maybeRegisterModelAdapter). */
  private adapterRegistration: { adapter: PiCatalogAdapter; ctx: Context } | undefined

  /**
   * Register the pi model catalog as LLM routes once BOTH the catalog read
   * has settled and this kernel owns the factory slot. The model picker
   * follows the kernel: while pi drives, only pi's list is shown. Native
   * routes for ids the pi catalog also carries must leave the registry
   * before this registration (DUPLICATE_ADAPTER otherwise), and the remaining
   * native routes are stashed so the picker shows exactly the list the active
   * kernel can drive.
   */
  private maybeRegisterModelAdapter(): void {
    const registration = this.adapterRegistration
    if (registration === undefined || !this.kernelOwned || this.adapterHandle !== undefined) return
    if (!this.isActive() || this.catalogValue === undefined) return
    this.stashNativeAdapters(registration.adapter, [...this.catalogValue.providers])
    this.adapterHandle = registration.ctx.llm.registerAdapter(this.catalogValue.providers, registration.adapter)
    this.stashRemainingNativeAdapters(registration.adapter)
  }

  /**
   * Activate the native agent-loop kernel through the LOADER: one hot
   * reconcile over the profile patches, with the handoff marker just
   * written, so the row boots as a real host fiber (owning the `agentLoop`
   * service and the factory slot) exactly as a restart with the marker would.
   * A private handoff-loaded fiber here instead collided with this very
   * row-activation on the next re-enable's reconcile.
   */
  private async activateNativeKernelRow(ctx: Context): Promise<void> {
    try {
      const profile = this.runtime.ctx.get('profileContext') as
        | { dir?: string; patchPath?: string; home?: string; overlays?: unknown[] }
        | undefined
      if (profile === undefined) throw new Error('profileContext unavailable')
      const patches = readProfilePatches('dsh', profile as never)
      await reconcileProfilePatches(ctx.root, patches, 'dsh', ['agent-loop'])
      console.error('[pi-agent] native agent-loop row activated (factory handed over)')
      this.ctx.logger.info('pi-agent: factory handed to the native agent-loop row (plugin disabled)')
    } catch (error: unknown) {
      console.error(`[pi-agent] native row activation failed: ${errorChain(error)}`)
      this.ctx.logger.warn(`pi-agent: native row activation failed: ${errorChain(error)}`)
    }
  }

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
   * Whether the profile patch currently carries the handoff marker (the
   * native agent-loop row was re-enabled for a pi-off period). Synchronous:
   * the kernel effect must know BEFORE claiming — a marker-booted native row
   * is a required plugin of this same loader pass, and a racing pi claim
   * would abort the whole startup.
   */
  private hasHandoffMarker(): boolean {
    const path = this.profilePatchPath()
    if (path === undefined) return false
    try {
      return readFileSync(path, 'utf8').includes(HANDOFF_MARKER)
    } catch {
      return false
    }
  }

  /**
   * Post-loader-pass claim for a marker-booted start. The required native
   * row has claimed by now (waiting for the loader guarantees its mandatory
   * claim saw a free slot); take a stale-free slot directly, or retire the
   * native row through the boot takeover and claim the freed slot.
   */
  private async deferredClaim(ctx: Context): Promise<void> {
    try {
      await (ctx.root as unknown as { loader?: { await?: () => Promise<unknown> } }).loader?.await?.()
    } catch { /* a failed unrelated row must not block the claim decision */ }
    if (!this.isActive()) return
    try {
      this.adoptSlot(ctx, ctx.agents.setFactory(this))
      console.error('[pi-agent] kernel active (factory owned, after the loader pass)')
    } catch {
      this.retireNativeRowAndClaim(ctx)
    }
  }

  /**
   * Claim the factory slot and everything kernel-owned that follows from it
   * (projections, declarative agents, the restart marker). Runs after the
   * constructor's effect — synchronously on fresh boot.
   */
  private claimKernel(ctx: Context): void {
    try {
      this.adoptSlot(ctx, ctx.agents.setFactory(this))
    } catch {
      // A live enable while the native kernel row is serving (it booted from
      // the handoff marker during a pi-off period). Never take the field
      // live: the row's armed setFactory disposer would outlive its own
      // claim, and the next patch-file reload (the HMR watch fires on every
      // marker write) would retire that row — its disposer would kill our
      // stolen registration and drag its sessions out of the sidebar. Keep
      // the marker so the file keeps describing the running row, stay
      // inert, and let the next restart's deferredClaim take over: the
      // marker-booted native row claims first (its mandatory claim must see
      // a free slot), then the boot takeover retires it and pi claims.
      console.error('[pi-agent] factory slot held by the native kernel row — pi stays inert; restart dsh to switch to pi')
      this.ctx.logger.warn('pi-agent: restart dsh to switch the kernel to pi')
    }
  }

  /**
   * While true, a switch is retiring the native kernel row; sessions orphaned
   * by that retirement are re-mounted instead of dropping off the sidebar.
   */
  private switching = false

  /**
   * Sessions this kernel keeps mounted in the live store, with their enter
   * detach capabilities: pi-era publishes and native-era sessions adopted at
   * a boot takeover. Read by the teardown unmount, which frees the ids so
   * the next kernel cold-resumes from the shared log.
   */
  private sessionMounts = new Map<SessionId, { session: Session; detach: () => void }>()

  /**
   * Re-mount a session orphaned by the retiring native kernel row (see the
   * adoption listener). session/disposed dispatches after the store entry is
   * gone, so enter() cannot collide; the fresh entry re-announces as
   * session/created and the client re-adds the sidebar row it just dropped.
   * The re-mounted session is agentless (its agent died with the row) — the
   * next open resumes it under the current kernel from the shared log. The
   * mount is tracked so a later pi disable unmounts it like our own.
   */
  private adoptOrphanedSession(session: Session): void {
    if (!this.switching) return
    try {
      const detach = this.runtime.ctx.sessions.enter(session)
      this.sessionMounts.set(session.id, { session, detach })
      this.runtime.ctx.sessions.announce(session)
    } catch (error: unknown) {
      console.error(`[pi-agent] session adoption failed for "${session.id}": ${errorChain(error)}`)
    }
  }

  /**
   * Unmount every tracked session and hand its sidebar row back to the
   * client as a cold entry: capture the summary while the session is still
   * mounted (projections are live), detach — the session controller
   * broadcasts `api-session/removed` — then re-emit `api-session/added` with
   * the captured summary so the client re-adds the row. Net client-visible
   * effect: the row stays (agentless), and the store frees the id so the
   * next kernel cold-resumes the session from the shared log instead of
   * colliding with the id-uniqueness check on resume.
   */
  private unmountTrackedSessions(): void {
    for (const [id, mount] of this.sessionMounts) {
      this.sessionMounts.delete(id)
      try {
        // A stale entry: someone else detached (or replaced) the session —
        // its removal was broadcast by whoever detached it.
        if (this.runtime.ctx.sessions.get(id) !== mount.session) continue
        const summary = this.captureSidebarSummary(mount.session)
        mount.detach()
        // The session controller's remote-event vocabulary: string-typed on
        // the wire, and this package intentionally carries no dependency on
        // the controller's Events augmentation — hence the local signature.
        const announceAdded = this.runtime.ctx.emit as (name: string, payload: unknown) => void
        announceAdded('api-session/added', summary)
      } catch (error: unknown) {
        console.error(`[pi-agent] session unmount failed for "${id}": ${errorChain(error)}`)
      }
    }
  }

  /**
   * Build the `api-session/added` payload for a session about to leave the
   * store — mirroring `ApiSessionList.summaryFor`'s wire shape for a row
   * without a live agent. The projection block must be captured while the
   * session is still mounted; after the detach it would read as a cache
   * miss. The relay validates lossless JSON, so only plain wire views go out.
   */
  private captureSidebarSummary(session: Session): Record<string, unknown> {
    const header = session.header
    let block: { asOfSeq: number; values: Record<string, unknown> } | undefined
    try {
      const snapshot = this.runtime.ctx.sessionProjections.cachedSnapshot(session) as
        | { asOfSeq: number; values: Record<string, unknown> }
        | undefined
      if (snapshot !== undefined && Object.keys(snapshot.values).length > 0) block = snapshot
    } catch { /* serve the row without projections */ }
    const metadata = block?.values['sessionListMetadata'] as
      | { blank?: boolean; lastPromptAt?: number | null }
      | undefined
    return {
      sessionId: session.id,
      updatedAt: Math.max(header.createdAt, metadata?.lastPromptAt ?? 0),
      agentAvailable: false,
      running: false,
      blank: metadata?.blank ?? session.seq === 0,
      ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(block === undefined
        ? {}
        : { projections: { kind: 'sequenced', asOfSeq: block.asOfSeq, values: block.values } }),
    }
  }

  /**
   * Boot-time takeover: drop the marker (the recomposed state then disables
   * agent-loop again), let one hot reconcile retire the native row through
   * the loader — its own disposer frees its own claim — then claim the
   * genuinely free slot. Deferred past this effect's activation: the
   * reconcile waits on managed row fibers, and re-entrancy from inside the
   * activation would deadlock on our own fiber's startup. The switching flag
   * arms the adoption listener for the orphaned native sessions.
   */
  private async retireNativeRowAndClaim(ctx: Context): Promise<void> {
    this.switching = true
    try {
      await this.clearHandoffMarker()
      await new Promise(resolve => setTimeout(resolve, 80))
      const profile = this.runtime.ctx.get('profileContext') as
        | { dir?: string; patchPath?: string; home?: string; overlays?: unknown[] }
        | undefined
      if (profile === undefined) throw new Error('profileContext unavailable')
      const patches = readProfilePatches('dsh', profile as never)
      await reconcileProfilePatches(ctx.root, patches, 'dsh', ['pi-agent'])
      if (!this.isActive()) return // toggled off while the native row retired
      this.adoptSlot(ctx, ctx.agents.setFactory(this))
      console.error('[pi-agent] claimed the factory slot after the native kernel row retired (boot takeover)')
    } catch (error: unknown) {
      console.error(`[pi-agent] boot takeover failed: ${errorChain(error)} — restart dsh to switch to pi`)
      this.ctx.logger.warn(`pi-agent: boot takeover failed: ${errorChain(error)}`)
    } finally {
      this.switching = false
    }
  }

  /** Bind the factory registration and everything kernel-owned that follows. */
  private adoptSlot(ctx: Context, disposeFactory: () => void): void {
    this.factoryDisposer = disposeFactory
    this.kernelOwned = true
    // Won the slot: pi is the kernel again, so a restart must boot pi —
    // drop the handoff marker that re-enables the native loop.
    void this.clearHandoffMarker()
    // Won the slot: this factory owns the projections too (the native UI
    // reads them; the disabled default loop no longer registers them).
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    ctx.sessionProjections.register(inboxProjectionDefinition)
    this.maybeRegisterModelAdapter()
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
    // A preserved mount (kernel switches keep sessions mounted so the sidebar
    // never drops a row) can already hold this id in the live store after a
    // same-process kernel switch; entering a second session with the same id
    // is rejected by the store. Rebuild the driver on the LIVE session — its
    // committed events are the shared log, so nothing needs re-reading and no
    // write handle is taken.
    const live = this.runtime.ctx.sessions.get(id)
    if (live !== undefined) {
      return await this.setupAndPublish(
        ownerCtx,
        id,
        SessionPreparation.create(live),
        this.piOptions(options.agentOptions ?? {}),
        options.setup,
        options.signal,
        'resume',
        undefined,
        options.parentAgent,
        true,
      )
    }
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
    reuseLiveSession = false,
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
    let published = false
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
        // A PUBLISHED agent's session stays mounted (tracked in
        // sessionMounts) so the sidebar keeps the row after a normal close;
        // the kernel-teardown unmount frees it later, re-adding the row as a
        // cold entry. A FAILED publish rolls its fresh mount back here — the
        // session was never announced, so the detach is silent.
        if (!published) {
          const mount = this.sessionMounts.get(id)
          this.sessionMounts.delete(id)
          if (mount !== undefined && this.runtime.ctx.sessions.get(id) === mount.session) {
            try { mount.detach() } catch { /* single-shot; stale is fine */ }
          }
        }
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
        // Mount the session under THIS plugin's declared injection, never
        // the caller context: the mount carrier is owned by the sessions
        // service itself, so the caller's fiber ancestry is irrelevant — and
        // reading caller-provided contexts through the inject guard breaks
        // whenever the row graph shifts. The mount is tracked in
        // sessionMounts: the kernel teardown unmounts it (re-adding the
        // sidebar row as a cold entry) so the NEXT kernel can cold-resume
        // the session instead of hitting the store's id uniqueness. A
        // reused LIVE session is already entered and announced (adopted at a
        // boot takeover, or still mounted from an earlier pi era); entering
        // it again is rejected by the store, so only the agent attaches.
        if (!reuseLiveSession) {
          const detach = loopCtx.sessions.enter(session)
          this.sessionMounts.set(id, { session, detach })
        }
        detachAgent = loopCtx.agents.enter(agent, parentAgent)
        if (!reuseLiveSession) {
          loopCtx.sessions.announce(session)
        }
        assertLive()
        await loopCtx.agents.announce(agent, source, abort.signal)
        published = true
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
    reuseLiveSession = false,
  ): Promise<AgentHandle> {
    const session = preparation.session
    let prepared: PreparedAgent
    try {
      prepared = this.prepare(ownerCtx, id, agentOptions, session, signal, stored?.handle, parentAgent, reuseLiveSession)
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
