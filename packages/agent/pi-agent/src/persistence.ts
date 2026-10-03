/**
 * pi-only session persistence: a `SessionPersistence` backend whose durable
 * store IS the pi session directory. Live turns run on in-memory handles
 * (dsh logs are never written); reads, resumes, listing, and stats replay or
 * scan the pi JSONL files through {@link replayPiSession}.
 *
 * Mounted by the pi-agent bundle patch when `DSH_PI_ONLY=1` (replacing the
 * default jsonl backend); the default deployment keeps the dual-write layout.
 *
 * @module @deepseek-ai/dsh-pi-agent/persistence
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionPersistence, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleReadResult,
  SessionPersistenceCreateOptions,
  SessionPersistenceListOptions,
  SessionPersistenceOpenOptions,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { replayPiSession } from './replay.ts'

export { replayPiSession }

/** Default pi data root — must match the kernel service's defaultDataDir(). */
function defaultRoot(): string {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? join(process.env.DSH_HOME, 'pi-agent')
    : join(homedir(), '.dsh', 'pi-agent')
}

/** In-memory write sink standing in for the dsh log (contents live and die with the process). */
class MemorySessionHandle implements SessionHandle {
  readonly inheritedEventCount: ReturnType<typeof SessionLogOffset> = SessionLogOffset(0)
  private closed = false

  constructor(
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    private readonly events: SessionEvent[],
  ) {}

  async read(offset = 0, length = Number.POSITIVE_INFINITY): Promise<SessionHandleReadResult> {
    this.assertOpen()
    const start = Math.max(0, offset)
    const slice = start >= this.events.length ? [] : this.events.slice(start, start + length)
    // Freshly constructed or replayed values: ownership transfers to the caller.
    return { eventState: 'detached' as const, events: slice }
  }

  async append(batch: readonly SessionEvent[]): Promise<void> {
    this.assertOpen()
    if (this.access !== 'write') throw new Error(`session "${this.id}": read-only handle`)
    let expected = this.events.length
    for (const event of batch) {
      if (event.seq !== expected) {
        throw new Error(`session "${this.id}": appended event seq ${String(event.seq)} does not continue the log (next ${String(expected)})`)
      }
      expected += 1
    }
    this.events.push(...batch)
  }

  async flush(): Promise<void> {
    this.assertOpen()
  }

  async close(): Promise<void> {
    this.closed = true
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`session "${this.id}": handle is closed`)
  }
}

/** Persistence backend over the pi session directory. */
export class PiSessionPersistence extends SessionPersistence {
  static Config = z.object({
    /** pi session JSONL root; must match the kernel service's dataDir. */
    root: z.string(),
  })

  private readonly root: string

  constructor(ctx: Context, config: { root?: string } | null) {
    super(ctx)
    this.root = config?.root ?? defaultRoot()
  }

  /** A fresh session's in-memory sink; contents vanish with the process. */
  async create(header: SessionHeader, _options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    return new MemorySessionHandle(header.id, header, 'write', [])
  }

  /**
   * Replay the pi file into a preloaded handle. Write access continues the
   * replayed log in memory (interrupted-turn closers append here); read
   * access serves exports and search.
   */
  async open(id: SessionId, access: SessionAccess, _options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    const file = this.sessionFile(id)
    if (!existsSync(file)) {
      throw new SessionPersistenceNotFoundError(id)
    }
    const raw = await readFile(file, 'utf8')
    const replayed = replayPiSession(raw, `${id}.jsonl`)
    if (replayed === undefined) {
      throw new SessionPersistenceNotFoundError(id)
    }
    return new MemorySessionHandle(id, replayed.header, access, [...replayed.events])
  }

  /** Durability is pi's own concern; nothing to flush host-side. */
  async flush(): Promise<void> {}

  /** One session's synthesized snapshot, or undefined without a pi file. */
  async stat(id: SessionId, _options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    const file = this.sessionFile(id)
    if (!existsSync(file)) return undefined
    const raw = await readFile(file, 'utf8')
    const replayed = replayPiSession(raw, `${id}.jsonl`)
    if (replayed === undefined) return undefined
    return { header: replayed.header, revision: SessionPersistenceRevision(String(replayed.events.length)), eventCount: replayed.events.length }
  }

  /** Scan the pi directory and synthesize one snapshot per session file. */
  async list(_options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    if (!existsSync(this.root)) return []
    const names = await readdir(this.root)
    const snapshots: SessionPersistenceSnapshot[] = []
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const raw = await readFile(join(this.root, name), 'utf8')
        const replayed = replayPiSession(raw, name)
        if (replayed === undefined) continue
        snapshots.push({
          header: replayed.header,
          revision: SessionPersistenceRevision(String(replayed.events.length)),
          eventCount: replayed.events.length,
        })
      } catch {
        // Unreadable file: skip it, the rest of the corpus stays visible.
      }
    }
    return snapshots
  }

  private sessionFile(id: SessionId): string {
    return join(this.root, `${id}.jsonl`)
  }
}

export default PiSessionPersistence
