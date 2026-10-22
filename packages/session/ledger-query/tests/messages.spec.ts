import { Context, Service } from '@panedesk/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageDelivery } from '@panedesk/dsh-message-delivery'
import type { MessageAddress, MessageQuery, MessageRecipient, MessageStateEvent, ResolvedRecipient, SendMessageRequest, SendMessageResult } from '@panedesk/dsh-message-delivery'
import type { LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { LedgerQueryService } from '../src/index.ts'
import { parseLedgerArgs } from '../src/cli.ts'
import { serializeMessages } from '../src/messages.ts'
import type { LedgerMessageProjection, LedgerMessagesPage, LedgerSessionsPage, MessageLedgerReader } from '../src/types.ts'

const asOf = 1_800_000_000_000
function message(id: string, state: LedgerMessageProjection['state'] = 'queued', messageClass: LedgerMessageProjection['data']['messageClass'] = 'handoff', age = 11): LedgerMessageProjection {
  const messageId = id as LedgerMessageProjection['messageId']
  const data: LedgerMessageProjection['data'] = { messageId, senderSessionId: null,
    targetSessionId: 'session-a' as NonNullable<MessageQuery['sessionId']>, priority: 'steer', messageClass, state,
    revision: 2, stateVersion: 1, operationId: `operation-${id}` as LedgerMessageProjection['data']['operationId'],
    transition: state === 'queued' ? 'accepted' : state, observedAt: asOf - age * 60_000 }
  return { messageId, nodeId: 'node-a' as LedgerMessageProjection['nodeId'], data, state, phase: state === 'queued' ? 'pending' : 'settled',
    revision: 2, stateVersion: 1, createdAt: data.observedAt, stateTimes: { [state]: data.observedAt },
    transitions: [{ cursor: `event-${id}` as MessageStateEvent['cursor'], nodeId: 'node-a' as MessageStateEvent['nodeId'], data }] }
}
function recipient(id: string, status: MessageRecipient['status'] = 'idle'): MessageRecipient {
  return { nodeId: 'node-a' as MessageRecipient['nodeId'], sessionId: id as MessageRecipient['sessionId'],
    window: `window-${id}`, title: `seat-${id}`, status, matchedFields: ['sessionId'], observedAt: asOf }
}
class Delivery extends MessageDelivery {
  writes = 0
  wakes = 0
  sender = { kind: 'human', sessionId: null } as const
  sent: { request: SendMessageRequest; sender: { readonly kind: 'human'; readonly sessionId: null } }[] = []
  resolveCalls = 0
  controls: { kind: string; request: Parameters<MessageDelivery['withdraw']>[0] }[] = []
  override async send(request: SendMessageRequest): Promise<SendMessageResult> {
    this.writes++
    this.sent.push({ request, sender: this.sender })
    const id = request.target.sessionId ?? request.target.name ?? ''
    const target = recipient(id, id === 'session-c' ? 'closed' : id === 'session-b' ? 'busy' : 'idle')
    const common = { messageId: `message-${id}` as SendMessageResult['messageId'], operationId: request.operationId, recipient: target }
    if (target.status === 'closed') return { ...common, deliveryOutcome: 'rejected', messageState: 'queued', pending: true, reason: 'target-closed-pending' }
    if (target.status === 'idle') this.wakes++
    return { ...common, deliveryOutcome: 'accepted', messageState: 'queued', pending: false }
  }
  override async resolve(addresses: readonly MessageAddress[]): Promise<ResolvedRecipient[]> {
    this.resolveCalls++
    return addresses.map(address => address.name === 'ambiguous' ? { kind: 'rejected', address, reason: 'target-ambiguous', candidates: [recipient('session-a'), recipient('session-b')] }
      : { kind: 'resolved', address, recipient: recipient(address.sessionId ?? address.name ?? '', address.sessionId === 'session-c' ? 'closed' : 'idle') })
  }
  override async sendBatch(request: Parameters<MessageDelivery['sendBatch']>[0]): ReturnType<MessageDelivery['sendBatch']> {
    if (request.dryRun) throw new Error('Dry run must not enter a write-capable method')
    const classification = request.messageClass === 'reply' ? { messageClass: request.messageClass, replyTo: request.replyTo } : { messageClass: request.messageClass }
    const results = await Promise.all(request.recipients.map(item => this.send({ ...classification, target: item.target,
      operationId: item.operationId, content: request.content, ...request.priority === undefined ? {} : { priority: request.priority } })))
    return { kind: 'sent', results }
  }
  override async status(id: Parameters<MessageDelivery['status']>[0]) {
    if (id === 'missing') throw Object.assign(new Error('not found'), { code: 'message-not-found' })
    return message(id, id === 'injected' ? 'injected' : 'queued')
  }
  private async control(kind: string, request: Parameters<MessageDelivery['withdraw']>[0]): ReturnType<MessageDelivery['withdraw']> {
    this.controls.push({ kind, request })
    const status = await this.status(request.messageId)
    if (request.messageId === 'injected') return { kind: 'rejected', reason: 'injected', status, operationId: request.operationId, messageId: request.messageId }
    if (request.messageId === 'offline') return { kind: 'accepted-pending-owner', state: 'queued', revision: 2, operationId: request.operationId, messageId: request.messageId }
    return { kind: 'applied', status, operationId: request.operationId, messageId: request.messageId }
  }
  override withdraw(request: Parameters<MessageDelivery['withdraw']>[0]) { return this.control('withdraw', request) }
  override edit(request: Parameters<MessageDelivery['edit']>[0]) { return this.control('edit', request) }
  override reprioritize(request: Parameters<MessageDelivery['reprioritize']>[0]) { return this.control('reprioritize', request) }
  override invalidate(request: Parameters<MessageDelivery['invalidate']>[0]) { return this.control('invalidate', request) }
  override async operationStatus(operationId: Parameters<MessageDelivery['operationStatus']>[0]): ReturnType<MessageDelivery['operationStatus']> {
    return { kind: 'not-found', operationId }
  }
  override async list(): ReturnType<MessageDelivery['list']> { throw new Error('Queries must use the journal reader') }
  override async configure(request: Parameters<MessageDelivery['configure']>[0]) { return request.settings }
  subscription: Parameters<MessageDelivery['subscribe']>[0] | undefined
  override async *subscribe(request: Parameters<MessageDelivery['subscribe']>[0]) {
    this.subscription = request
    yield message('watched').transitions[0]!
  }
}
class Reader extends Service implements MessageLedgerReader {
  items: LedgerMessageProjection[] = []
  complete = true
  queries: MessageQuery[] = []
  joins: Parameters<MessageLedgerReader['querySessions']>[0][] = []
  constructor(ctx: Context) { super(ctx, 'sessionLedger') }
  async queryMessages(query: MessageQuery): Promise<LedgerMessagesPage> {
    this.queries.push(query)
    const selected = this.items.filter((item) => {
      const data = item.data
      if (query.sessionId !== undefined && query.sessionId !== data.targetSessionId && query.sessionId !== data.senderSessionId
        || query.senderSessionId !== undefined && query.senderSessionId !== data.senderSessionId
        || query.targetSessionId !== undefined && query.targetSessionId !== data.targetSessionId
        || query.nodeId !== undefined && query.nodeId !== item.nodeId
        || query.from !== undefined && item.createdAt < query.from || query.to !== undefined && item.createdAt >= query.to
        || query.states !== undefined && !query.states.includes(item.state)
        || query.messageClasses !== undefined && !query.messageClasses.includes(data.messageClass)) return false
      if (query.unansweredOlderThanMinutes !== undefined && (data.messageClass === 'notice' || item.stateTimes.responded !== undefined
        || item.createdAt >= Date.now() - query.unansweredOlderThanMinutes * 60_000
        || !query.includeTerminal && ['withdrawn', 'invalidated', 'rejected'].includes(item.state))) return false
      return true
    }).sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId))
    const start = query.cursor === undefined ? 0 : selected.findIndex(item => String(item.messageId) === query.cursor) + 1
    const items = selected.slice(start, query.limit === undefined ? undefined : start + query.limit)
    const last = items.at(-1)
    return { items, asOf, complete: this.complete, ...last && start + items.length < selected.length ? { nextCursor: last.messageId as string as NonNullable<MessageQuery['cursor']> } : {} }
  }
  async querySessions(query: Parameters<MessageLedgerReader['querySessions']>[0]): Promise<LedgerSessionsPage> {
    this.joins.push(query)
    return { asOf, complete: this.complete, sessions: [{ sessionId: 'session-a' as NonNullable<MessageQuery['sessionId']>, calls: [], messages: this.items }], unassignedMessages: [] }
  }
  async snapshot(): Promise<LedgerSnapshot> { return { asOf, complete: true, rows: [], watermarks: {} } }
}
const contexts: Context[] = []
const paths: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function setup(delivery = true, reader = true) {
  const ctx = new Context()
  contexts.push(ctx)
  if (delivery) await ctx.plugin(Delivery)
  if (reader) await ctx.plugin(Reader)
  await ctx.plugin(LedgerQueryService)
  return { ctx, query: ctx.get('ledgerQuery')!, delivery: ctx.get('messageDelivery') as Delivery,
    get reader(): Reader {
      const service = ctx.get('sessionLedger')
      if (!(service instanceof Reader)) throw new Error('Missing reader fixture')
      return service
    } }
}
const recipients = JSON.stringify([{ sessionId: 'session-a' }, { sessionId: 'session-b' }, { sessionId: 'session-c' }])

describe('message CLI commands', () => {
  it('sends an explicit three-recipient batch and preserves a closed pending rejection', async () => {
    const { query, delivery } = await setup()
    const result = await query.execute(['messages', 'send-batch', '--recipients', recipients, '--class', 'handoff', '--text', 'Review this item'])
    expect(result.code).toBe(4)
    expect(result.output).toMatchObject({ kind: 'sent', results: [
      { recipient: { sessionId: 'session-a', status: 'idle' }, deliveryOutcome: 'accepted' },
      { recipient: { sessionId: 'session-b', status: 'busy' }, deliveryOutcome: 'accepted' },
      { recipient: { sessionId: 'session-c', status: 'closed' }, deliveryOutcome: 'rejected', reason: 'target-closed-pending', messageState: 'queued', pending: true },
    ] })
    expect(delivery.writes).toBe(3)
    expect(new Set(delivery.sent.map(item => item.request.operationId)).size).toBe(3)
    expect(delivery.sent.every(item => item.request.priority === 'steer')).toBe(true)
    expect(delivery.sent.map(item => item.sender)).toEqual(Array.from({ length: 3 }, () => ({ kind: 'human', sessionId: null })))
  })
  it('dry-runs explicit recipients with zero mailbox writes and zero wakeups', async () => {
    const { query, delivery } = await setup()
    const batch = vi.spyOn(delivery, 'sendBatch')
    const result = await query.execute(['messages', 'send-batch', '--recipients', recipients, '--dry-run'])
    expect(result).toMatchObject({ code: 0, output: { kind: 'resolved', recipients: [
      { recipient: { sessionId: 'session-a' } }, { recipient: { sessionId: 'session-b' } }, { recipient: { sessionId: 'session-c', status: 'closed' } },
    ] } })
    expect(delivery.resolveCalls).toBe(1)
    expect(delivery.writes).toBe(0)
    expect(delivery.wakes).toBe(0)
    expect(batch).not.toHaveBeenCalled()
    expect((await query.execute(['messages', 'resolve', '--recipients', '[{"name":"ambiguous"}]'])).code).toBe(4)
    expect(delivery.writes).toBe(0)
  })
  it('lists only overdue unanswered handoffs and replies unless terminal auditing is requested', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(asOf)
    const { query, reader } = await setup(false)
    const invalidatedResponse = { ...message('responded-then-invalidated', 'invalidated'), stateTimes: { responded: asOf - 1000, invalidated: asOf } }
    const closed = message('closed-pending')
    const pending: LedgerMessageProjection = { ...closed, data: { ...closed.data, deliveryOutcome: 'rejected', pending: true, reason: 'target-closed-pending' } }
    reader.items = [message('overdue'), message('reply', 'injected', 'reply'), pending, message('boundary', 'queued', 'handoff', 10),
      message('recent', 'queued', 'handoff', 9), message('notice', 'queued', 'notice'), message('done', 'responded'),
      message('withdrawn', 'withdrawn'), message('invalidated', 'invalidated'), message('rejected', 'rejected'), invalidatedResponse]
    const result = await query.execute(['messages', 'unanswered', '--older-than-minutes', '10'])
    expect(result.code).toBe(0)
    expect(result.output).toMatchObject({ page: { items: [{ messageId: 'closed-pending' }, { messageId: 'overdue' }, { messageId: 'reply' }], complete: true },
      joined: { sessions: [{ sessionId: 'session-a', messages: [{ messageId: 'overdue' }, { messageId: 'reply' }, { messageId: 'closed-pending' }] }] } })
    expect(reader.queries[0]).toEqual({ unansweredOlderThanMinutes: 10, messageClasses: ['handoff', 'reply'] })
    const audit = await query.execute(['messages', 'unanswered', '--older-than-minutes', '10', '--include-terminal'])
    const audited = audit.output as { page: LedgerMessagesPage }
    expect(audited.page.items.map(item => item.messageId)).toContain('withdrawn')
    expect(audited.page.items.map(item => item.messageId)).toContain('rejected')
  })
  it('forwards all journal filters and merges call and message namespaces by session', async () => {
    const { query, reader } = await setup(false)
    reader.items = [message('matching'), message('excluded', 'withdrawn')]
    const result = await query.execute(['messages', 'query', '--session', 'session-a', '--target-session', 'session-a', '--node', 'node-a',
      '--from', '2027-01-01T00:00:00Z', '--to', '2028-01-01T00:00:00Z', '--state', 'queued', '--class', 'handoff', '--limit', '1'])
    expect(result).toMatchObject({ code: 0, output: { page: { items: [{ messageId: 'matching' }] }, joined: { sessions: [{ sessionId: 'session-a', messages: [{ messageId: 'matching' }] }] } } })
    expect(reader.joins).toEqual([{ sessionId: 'session-a', from: Date.parse('2027-01-01T00:00:00Z'), to: Date.parse('2028-01-01T00:00:00Z') }])
    expect(reader.queries[0]).toMatchObject({ targetSessionId: 'session-a', nodeId: 'node-a', states: ['queued'], messageClasses: ['handoff'], limit: 1 })
    const origin = await query.execute(['messages', 'query', '--sender-session', 'session-b'])
    expect(origin).toMatchObject({ code: 0, output: { page: { items: [] } } })
    reader.complete = false
    expect((await query.execute(['messages', 'query'])).code).toBe(6)
  })
  it('exports filtered JSONL with stable order, exclusive cursors, schema version, integrity, and no bodies', async () => {
    const { query, reader } = await setup(false)
    reader.items = [message('b'), message('a'), message('terminal', 'withdrawn')]
    const page = await query.execute(['messages', 'export', '--format', 'jsonl', '--state', 'queued', '--limit', '1'])
    expect(page.code).toBe(0)
    expect(page.output).toMatchObject({ rows: 1, nextCursor: 'a', complete: true })
    const output = page.output as { jsonl: string }
    expect(output.jsonl.split('\n').filter(Boolean).map((line): unknown => JSON.parse(line))).toMatchObject([
      { schemaVersion: 1, kind: 'message/export', complete: true, nextCursor: 'a' },
      { schemaVersion: 1, kind: 'message/status', complete: true, item: { messageId: 'a' } },
    ])
    const dir = await mkdtemp(join(tmpdir(), 'ledger-message-export-')); paths.push(dir)
    const destination = join(dir, 'messages.jsonl')
    expect((await query.execute(['messages', 'export', '--format', 'jsonl', '--state', 'queued', '--cursor', 'a', '--output', destination])).code).toBe(0)
    expect(await readFile(destination, 'utf8')).toContain('"messageId":"b"')
    expect(await readFile(destination, 'utf8')).not.toContain('"messageId":"a"')
    expect((await query.execute(['messages', 'export', '--format', 'jsonl', '--output', destination])).code).toBe(1)
    const a = message('a'), b = message('b')
    const injected = { ...a, content: 'private body', data: { ...a.data, text: 'private body' }, transitions: a.transitions.map(event => ({ ...event, data: { ...event.data, content: 'private body' } })) }
    const serialized = serializeMessages({ items: [b, injected], asOf, complete: false })
    expect(serialized).toBe(serializeMessages({ items: [injected, b], asOf, complete: false }))
    expect(serialized).not.toContain('private body')
    expect(serialized).not.toMatch(/"(?:content|text)":/)
    reader.complete = false
    expect(await query.execute(['messages', 'export', '--format', 'jsonl', '--state', 'rejected'])).toMatchObject({ code: 6, output: { rows: 0, complete: false, jsonl: expect.stringContaining('"complete":false') as string } })
  })
  it('supports three priorities, notices, replies, and human origins without inventing sessions', async () => {
    const { query, delivery } = await setup()
    for (const priority of ['immediate', 'steer', 'queue']) expect((await query.execute(['messages', 'send', '--to-session', 'session-a', '--class', 'handoff', '--text', 'Review', '--priority', priority])).code).toBe(0)
    await query.execute(['messages', 'send', '--to-name', 'seat-a', '--class', 'notice', '--text', 'Notice', '--operation-id', 'operation-a'])
    await query.execute(['messages', 'send', '--to-session', 'session-a', '--class', 'reply', '--reply-to', 'message-a', '--text', 'Reply'])
    expect(delivery.sent[3]).toMatchObject({ request: { target: { name: 'seat-a' }, priority: 'queue', operationId: 'operation-a' }, sender: { kind: 'human', sessionId: null } })
    expect(delivery.sent[4]).toMatchObject({ request: { messageClass: 'reply', replyTo: 'message-a', priority: 'steer' } })
    expect(delivery.sent.every(item => !('senderSessionId' in item.request))).toBe(true)
  })
  it('adapts revision-checked controls and distinguishes offline intent from applied or rejected outcomes', async () => {
    const { query, delivery } = await setup()
    for (const [kind, extra] of [['withdraw', []], ['edit', ['--text', 'Updated']], ['reprioritize', ['--priority', 'immediate']], ['invalidate', ['--reason', 'Superseded']]] as const) {
      expect((await query.execute(['messages', kind, '--message-id', 'message-a', '--operation-id', 'operation-a', ...extra])).code).toBe(0)
    }
    expect(delivery.controls.map(item => item.kind)).toEqual(['withdraw', 'edit', 'reprioritize', 'invalidate'])
    expect(delivery.controls.every(item => item.request.expectedRevision === 2 && item.request.operationId === 'operation-a')).toBe(true)
    const status = vi.spyOn(delivery, 'status')
    expect((await query.execute(['messages', 'withdraw', '--message-id', 'offline', '--expected-revision', '1'])).output).toMatchObject({ kind: 'accepted-pending-owner', state: 'queued' })
    expect(status).toHaveBeenCalledTimes(1)
    expect((await query.execute(['messages', 'withdraw', '--message-id', 'injected'])).code).toBe(4)
    expect((await query.execute(['messages', 'status', '--message-id', 'message-a'])).output).toMatchObject({ messageId: 'message-a', transitions: [{ data: { observedAt: asOf - 660_000 } }] })
    expect((await query.execute(['messages', 'status', '--message-id', 'missing'])).code).toBe(5)
    expect((await query.execute(['messages', 'operation', '--operation-id', 'missing'])).code).toBe(5)
  })
  it('watches receipt events with an exclusive cursor and no mailbox writes', async () => {
    const { query, delivery } = await setup()
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    expect(await query.execute(['messages', 'watch', '--session', 'session-a', '--cursor', 'event-before'])).toEqual({ code: 0, output: { events: 1 } })
    expect(delivery.subscription).toEqual({ sessionId: 'session-a', cursor: 'event-before' })
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"cursor":"event-watched"'))
    expect(delivery.writes).toBe(0)
  })
  it('reports missing optional capabilities explicitly while preserving legacy ledger queries', async () => {
    const { query } = await setup(false, false)
    expect(await query.execute(['messages', 'query'])).toMatchObject({ code: 3, output: { error: { code: 'messages/query-unavailable' } } })
    expect(await query.execute(['messages', 'status', '--message-id', 'message-a'])).toMatchObject({ code: 3, output: { error: { code: 'messages/delivery-unavailable' } } })
    expect((await query.execute(['today'])).code).toBe(0)
    expect((await query.execute(['messages', '--help'])).output).toContain('panedesk --profile ledger messages')
    expect(await query.execute(['messages', 'send', '--to-session', 'a', '--to-name', 'b'])).toMatchObject({ code: 2, output: { error: { code: 'messages/invalid-arguments' } } })
  })
  it.each([
    [], ['unknown'], ['--help', '--extra'], ['send', '--to-session', 'a', '--to-name', 'b', '--class', 'handoff', '--text', 'x'],
    ['send', '--class', 'handoff', '--text', 'x'], ['send', '--to-session', 'a'], ['send', '--to-session', 'a', '--class', 'guess', '--text', 'x'],
    ['send', '--to-session', 'a', '--class', 'reply', '--text', 'x'], ['send', '--to-session', 'a', '--class', 'notice', '--text', 'x', '--priority', 'steer'],
    ['send', '--to-session', 'a', '--class', 'handoff', '--text', ' '], ['send', '--to-session', 'a', '--class', 'handoff', '--text', 'x', '--reply-to', 'b'],
    ['withdraw'], ['edit', '--message-id', 'a'], ['reprioritize', '--message-id', 'a', '--priority', 'guess'], ['invalidate', '--message-id', 'a'],
    ['status', '--message-id', 'a', '--text', 'x'], ['operation'], ['query', '--limit', '0'], ['query', '--limit', '1.5'], ['query', '--state', 'read'],
    ['query', '--class', 'guess'], ['query', '--class', 'handoff,handoff'], ['query', '--from', '2026-10-22'],
    ['query', '--from', '2026-10-23T00:00Z', '--to', '2026-10-22T00:00Z'], ['query', '--limit', '2', '--limit', '3'],
    ['query', '--unknown'], ['unanswered'], ['unanswered', '--older-than-minutes', '-1'], ['unanswered', '--older-than-minutes', '10', '--class', 'notice'],
    ['export', '--format', 'csv'], ['resolve', '--recipients', '*'], ['resolve', '--recipients', '[]'], ['resolve', '--recipients', '[{"name":"*"}]'],
    ['resolve', '--recipients', '[{"name":"seat-a","sessionId":"a"}]'], ['resolve', '--recipients', '[{"sessionId":"a","name":2}]'],
    ['resolve', '--recipients', '[{"sessionId":"a","unknown":true}]'], ['send-batch', '--recipients', '[{"sessionId":"a"}]'], ['watch'],
    ['withdraw', '--message-id', 'a', '--expected-revision', '1.5'], ['status', '--message-id', 'a b'],
  ])('rejects mutually exclusive, malformed, duplicate, or inapplicable options %j', (...args) => {
    expect(() => parseLedgerArgs(['messages', ...args])).toThrow()
  })
})
