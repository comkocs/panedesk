/** Runtime registrations describe existing Session lease holders, never acquire a competing lease. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { unlink } from 'node:fs/promises'
import { readProcessIdentity, sameProcessIdentity, type SubprocessIdentity } from '@panedesk/dsh-subprocess'
import type { FileMailbox } from './mailbox.ts'
import { component, isMissing, MailboxUnavailableError, object, publish, publishedFiles, readValue, syncDirectory } from './files.ts'

/** One live lease-backed residency. */
export interface OwnedSession {
  readonly sessionId: string
  readonly generation: string
  readonly status: 'busy' | 'idle' | 'closing'
}
/** Published process registration; heartbeat age alone never establishes death. */
export interface ProcessRegistration {
  readonly version: 1
  readonly identity: SubprocessIdentity
  readonly generation: string
  readonly sessions: readonly OwnedSession[]
  readonly heartbeat: number
  readonly capabilityVersion: 1
}

/** Decode persisted identity without mistaking absent evidence for a dead process. */
function decodeRegistration(value: unknown): ProcessRegistration {
  if (!object(value) || value.version !== 1 || value.capabilityVersion !== 1 || !object(value.identity)
    || !Number.isSafeInteger(value.identity.pid) || Number(value.identity.pid) <= 0
    || typeof value.generation !== 'string' || typeof value.heartbeat !== 'number' || !Array.isArray(value.sessions)) {
    throw new MailboxUnavailableError('Invalid process registration')
  }
  const raw = value.identity
  if ((raw.startIdentity !== undefined && typeof raw.startIdentity !== 'string')
    || (raw.bootIdentity !== undefined && typeof raw.bootIdentity !== 'string')
    || (raw.startedAt !== undefined && typeof raw.startedAt !== 'number')
    || (raw.processGroupId !== undefined && !Number.isSafeInteger(raw.processGroupId))) {
    throw new MailboxUnavailableError('Invalid process creation evidence')
  }
  const identity: SubprocessIdentity = {
    pid: Number(raw.pid),
    ...(typeof raw.startIdentity === 'string' ? { startIdentity: raw.startIdentity } : {}),
    ...(typeof raw.bootIdentity === 'string' ? { bootIdentity: raw.bootIdentity } : {}),
    ...(typeof raw.startedAt === 'number' ? { startedAt: raw.startedAt } : {}),
    ...(typeof raw.processGroupId === 'number' ? { processGroupId: raw.processGroupId } : {}),
  }
  const sessions = value.sessions.map((session: unknown): OwnedSession => {
    if (!object(session) || typeof session.sessionId !== 'string' || typeof session.generation !== 'string'
      || !['busy', 'idle', 'closing'].includes(String(session.status))) throw new MailboxUnavailableError('Invalid registered Session')
    return { sessionId: component(session.sessionId), generation: component(session.generation), status: session.status as OwnedSession['status'] }
  })
  return { version: 1, capabilityVersion: 1, identity, generation: component(value.generation), heartbeat: value.heartbeat, sessions }
}

/** Owns this process's registration and fences each residency by generation. */
export class NodeRegistry {
  /** Unique registration identity for this process incarnation. */
  readonly generation = randomUUID()
  private readonly sessions = new Map<string, OwnedSession>()
  private readonly identity: SubprocessIdentity
  private readonly path: string
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly mailbox: FileMailbox, private readonly inspect = readProcessIdentity) {
    this.identity = inspect(process.pid)
    this.path = join(mailbox.root, 'registry', `${process.pid}-${this.generation}.json`)
  }

  /** Register only after the caller has acquired the Session write lease.
   * @param sessionId - lease-backed Session.
   * @param status - observed runtime state.
   * @returns unique residency generation.
   */
  async register(sessionId: string, status: 'busy' | 'idle'): Promise<string> {
    if (!sameProcessIdentity(this.identity, this.inspect(this.identity.pid))) throw new MailboxUnavailableError('Process identity is unavailable')
    const generation = randomUUID()
    this.sessions.set(sessionId, { sessionId, generation, status })
    await publish(join(this.mailbox.root, 'owners', `${component(sessionId)}.json`), { generation, process: this.generation }, this.mailbox.options.maxRecordBytes)
    await this.heartbeat()
    return generation
  }

  /** Publish a runtime state without inventing liveness from the heartbeat.
   * @param sessionId - registered Session.
   * @param status - current state or closing before lease release.
   */
  async update(sessionId: string, status: OwnedSession['status']): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.set(sessionId, { ...session, status })
    await this.heartbeat()
  }

  /** Remove registration after lease release; owner generation prevents stale teardown from deleting a successor.
   * @param sessionId - released Session.
   */
  async unregister(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
    await this.heartbeat()
  }

  /** Verify the persisted owner generation immediately before owner-only work.
   * @param sessionId - leased Session.
   * @param generation - generation captured at registration.
   */
  async assertOwner(sessionId: string, generation: string): Promise<void> {
    const value = await readValue(join(this.mailbox.root, 'owners', `${component(sessionId)}.json`), this.mailbox.options.maxRecordBytes)
    if (!object(value) || value.generation !== generation || value.process !== this.generation
      || this.sessions.get(sessionId)?.generation !== generation) throw new MailboxUnavailableError('Session owner generation changed')
  }

  /** Publish one complete per-process registration. */
  heartbeat(): Promise<void> {
    const work = this.writes.then(() => publish(this.path, {
      version: 1, identity: this.identity, generation: this.generation,
      sessions: [...this.sessions.values()], heartbeat: Date.now(), capabilityVersion: 1,
    } satisfies ProcessRegistration, this.mailbox.options.maxRecordBytes))
    this.writes = work
    return work
  }

  /** Resolve busy/idle only from a verified incarnation; unknown evidence fails closed.
   * @param sessionId - target Session.
   * @returns runtime status, or unavailable when ownership cannot be established.
   */
  async status(sessionId: string): Promise<'busy' | 'idle' | 'closed' | 'unavailable'> {
    const candidates: OwnedSession[] = []
    for (const name of await publishedFiles(join(this.mailbox.root, 'registry'))) {
      const registration = decodeRegistration(await readValue(join(this.mailbox.root, 'registry', name), this.mailbox.options.maxRecordBytes))
      const session = registration.sessions.find(item => item.sessionId === sessionId)
      if (!session) continue
      const current = this.inspect(registration.identity.pid)
      if (current.startIdentity === undefined) {
        // ESRCH is the only PID-only observation that verifies absence; EPERM remains unknown.
        try { process.kill(registration.identity.pid, 0) } catch (error) {
          if (object(error) && error.code === 'ESRCH') continue
        }
        return 'unavailable'
      }
      if (!sameProcessIdentity(registration.identity, current)) {
        if (registration.identity.startIdentity === undefined) return 'unavailable'
        continue
      }
      const owner = await readValue(join(this.mailbox.root, 'owners', `${component(sessionId)}.json`), this.mailbox.options.maxRecordBytes)
      if (!object(owner) || owner.generation !== session.generation || owner.process !== registration.generation) continue
      candidates.push(session)
    }
    if (candidates.length === 0) return 'closed'
    if (candidates.length !== 1 || candidates[0]?.status === 'closing') return 'unavailable'
    return candidates[0]?.status ?? 'unavailable'
  }

  /** Remove only this process's file after all lease-backed residencies have ended. */
  async dispose(): Promise<void> {
    if (this.sessions.size !== 0) throw new MailboxUnavailableError('Cannot remove a registry with active Session leases')
    await this.writes
    try { await unlink(this.path) } catch (error) {
      if (!isMissing(error)) throw error
    }
    await syncDirectory(join(this.mailbox.root, 'registry'))
  }
}
