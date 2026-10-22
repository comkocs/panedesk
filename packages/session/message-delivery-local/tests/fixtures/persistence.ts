/** Test-only persistence substitute retaining Session records and exclusive write ownership. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import AgentRegistry from '@panedesk/dsh-agent'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SessionStore, { SessionId, type SessionEvent, type SessionHeader } from '@panedesk/dsh-session'
import type { MessageLedgerEvent, MessageLedgerStore } from '@panedesk/dsh-session-ledger'
import type { MessageCursor, MessageStateEvent } from '@panedesk/dsh-message-delivery'
import type {} from '@panedesk/dsh-message-delivery'
import LocalMessageDelivery from '../../src/index.ts'
import { schedulerFixture } from './owner.ts'
import { SessionLogOffset } from '@panedesk/dsh-session'
import SessionPersistence, { type SessionHandle, type SessionAccess, type SessionPersistenceSnapshot } from '@panedesk/dsh-session-persistence'

/** In-memory storage with explicit handle closure and write ownership. */
export class MemoryPersistence extends SessionPersistence {
  private readonly records = new Map<SessionId, { header: SessionHeader; events: SessionEvent[]; owned: boolean }>()
  async create(header: SessionHeader): Promise<SessionHandle> {
    if (this.records.has(header.id)) throw new Error('Session already exists')
    this.records.set(header.id, { header, events: [], owned: false })
    return this.open(header.id, 'write')
  }
  async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const record = this.records.get(id)
    if (!record) throw new Error('Session not found')
    if (access === 'write' && record.owned) throw new Error('Session already owned')
    if (access === 'write') record.owned = true
    let closed = false
    const check = () => { if (closed) throw new Error('Handle closed') }
    const close = async () => { if (!closed && access === 'write') record.owned = false; closed = true }
    return {
      id, access, header: record.header, inheritedEventCount: SessionLogOffset(0),
      async read(offset = 0, length = record.events.length) { check(); return { eventState: 'detached', events: structuredClone(record.events.slice(offset, offset + length)) } },
      async append(events) { check(); if (access !== 'write') throw new Error('Read only'); record.events.push(...events) },
      async flush() { check() }, close, [Symbol.asyncDispose]: close,
    }
  }
  async flush(): Promise<void> {}
  async stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const record = this.records.get(id)
    return record ? { header: record.header, revision: String(record.events.length) as SessionPersistenceSnapshot['revision'] } : undefined
  }
  async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return [...this.records.values()].map(record => ({ header: record.header,
      revision: String(record.events.length) as SessionPersistenceSnapshot['revision'] }))
  }
}

/** Record ledger calls; repeated event identities require identical content. */
export class RecordingLedger extends Service implements MessageLedgerStore {
  readonly calls: MessageLedgerEvent[] = []
  constructor(ctx: Context) { super(ctx, 'messageLedger') }
  async append(event: MessageLedgerEvent): Promise<MessageCursor> {
    const previous = this.calls.find(item => item.eventId === event.eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('Conflicting ledger event identity')
    this.calls.push(event)
    return event.eventId as string as MessageCursor
  }
  async read() { return { events: [...new Map(this.calls.map(item => [item.eventId, item])).values()], complete: true } }
}

/** Compose services through YAML and drive serial recovery with a scheduler substitute.
 * @param home - test-owned product home.
 * @returns services, ledger observations, and lease-ordered shutdown.
 */
export async function serviceFixture(home: string, watch = false) {
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(home).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, session: SessionStore, agents: AgentRegistry,
      persistence: MemoryPersistence, ledger: RecordingLedger, delivery: LocalMessageDelivery, projections: SessionProjectionRegistry })
    const profile = await readFile(new URL('../cordis.yml', import.meta.url), 'utf8')
    const path = join(home, 'cordis.yml')
    await writeFile(path, profile.replace('HOME_PLACEHOLDER', JSON.stringify(home)).replace('watch: false', `watch: ${watch}`))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    const service = ctx.get('messageDelivery')
    const ledger = ctx.get('messageLedger')
    if (!service || !(ledger instanceof RecordingLedger)) throw new Error('Test composition is not active')
    const emitted: MessageStateEvent[] = []
    ctx.on('message/state', (event) => {
      if (!ledger.calls.some(item => JSON.stringify(item.data) === JSON.stringify(event.data))) throw new Error('Notification preceded ledger commit')
      emitted.push(event)
    })
    const shutdown: (() => Promise<void>)[] = []
    const session = ctx.sessions.create(SessionId('seat-a'))
    await (await ctx.sessionPersistence.create(session.header)).close()
    return { ctx, service, ledger, emitted, session,
      async resume(target = session) {
        const lease = await ctx.sessionPersistence.open(target.id, 'write')
        const agents = ctx.agents
        const scheduler = schedulerFixture(ctx, target)
        const detach = agents.enter(scheduler.agent, undefined)
        const writes: Promise<void>[] = []
        const stop = ctx.on('session/event', (source, event) => {
          if (source === target) writes.push(lease.append([event]))
        })
        let closed = false
        const close = async () => {
          if (closed) return
          closed = true
          await agents.ending(scheduler.agent)
          stop()
          await Promise.all(writes)
          await lease.close()
          detach()
        }
        shutdown.push(close)
        await ctx.agents.announce(scheduler.agent, 'resume')
        return { ...scheduler, close }
      },
      async dispose() { for (const close of shutdown.reverse()) await close(); await ctx.fiber.dispose() },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
