/** Test-only persistence substitute retaining Session records and exclusive write ownership. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import AgentRegistry from '@panedesk/dsh-agent'
import SessionStore, { SessionId, type SessionEvent, type SessionHeader } from '@panedesk/dsh-session'
import type { MessageLedgerEvent, MessageLedgerStore } from '@panedesk/dsh-session-ledger'
import type { MessageCursor, MessageStateEvent } from '@panedesk/dsh-message-delivery'
import type {} from '@panedesk/dsh-message-delivery/src/events.ts'
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

/** 记录每次记账调用；同一事件身份须保持内容一致。 */
export class RecordingLedger extends Service implements MessageLedgerStore {
  readonly calls: MessageLedgerEvent[] = []
  constructor(ctx: Context) { super(ctx, 'messageLedger') }
  async append(event: MessageLedgerEvent): Promise<MessageCursor> {
    const previous = this.calls.find(item => item.eventId === event.eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('账本事件身份冲突')
    this.calls.push(event)
    return event.eventId as string as MessageCursor
  }
  async read() { return { events: [...new Map(this.calls.map(item => [item.eventId, item])).values()], complete: true } }
}

/** 通过实际 YAML 组合服务，以调度替身驱动恢复串行段。
 * @param home - 测试独占的产品家目录。
 * @returns 服务、账本观察与按租约顺序关闭的入口。
 */
export async function serviceFixture(home: string) {
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(home).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, session: SessionStore, agents: AgentRegistry,
      persistence: MemoryPersistence, ledger: RecordingLedger, delivery: LocalMessageDelivery })
    const profile = await readFile(new URL('../cordis.yml', import.meta.url), 'utf8')
    const path = join(home, 'cordis.yml')
    await writeFile(path, profile.replace('HOME_PLACEHOLDER', JSON.stringify(home)))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    const service = ctx.get('messageDelivery')
    const ledger = ctx.get('messageLedger')
    if (!service || !(ledger instanceof RecordingLedger)) throw new Error('测试组合未激活')
    const emitted: MessageStateEvent[] = []
    ctx.on('message/state', (event) => {
      if (!ledger.calls.some(item => JSON.stringify(item.data) === JSON.stringify(event.data))) throw new Error('通知早于账本提交')
      emitted.push(event)
    })
    const shutdown: (() => Promise<void>)[] = []
    const session = ctx.sessions.create(SessionId('seat-a'))
    await (await ctx.sessionPersistence.create(session.header)).close()
    return { ctx, service, ledger, emitted, session,
      async resume() {
        const lease = await ctx.sessionPersistence.open(session.id, 'write')
        const scheduler = schedulerFixture(ctx, session)
        const detach = ctx.agents.enter(scheduler.agent, undefined)
        shutdown.push(async () => { await ctx.agents.ending(scheduler.agent); await lease.close(); detach() })
        await ctx.agents.announce(scheduler.agent, 'resume')
        return scheduler
      },
      async dispose() { for (const close of shutdown.reverse()) await close(); await ctx.fiber.dispose() },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
