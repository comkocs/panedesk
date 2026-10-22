import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { brandString } from '@panedesk/dsh-brand'
import { MessageId } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import MessageDelivery, { type MessageStateEvent, type MessageSubscriptionRequest, type OperationId, type MessageCursor, type NodeId } from '@panedesk/dsh-message-delivery'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

const prefix = '_panedesk/messages/'
const names = ['send', 'withdraw', 'edit', 'reprioritize', 'invalidate', 'status', 'list', 'subscribe', 'resolve', 'sendBatch']
const methods = names.map(name => `${prefix}${name}`)
const notification = `${prefix}state`
const operationId = brandString<OperationId>('operation-a')
const messageId = MessageId('message-a')
const sessionId = SessionId('session-a')
const control = { messageId, operationId, expectedRevision: 0 }
const send = { target: { sessionId }, operationId, messageClass: 'handoff', content: 'Review this item' }
const status = { messageId, state: 'queued' as const, phase: 'pending' as const, revision: 0, stateVersion: 1, transitions: [] }
const event: MessageStateEvent = {
  cursor: brandString<MessageCursor>('cursor-a'), nodeId: brandString<NodeId>('node-a'),
  data: {
    messageId, operationId, senderSessionId: sessionId, targetSessionId: SessionId('child-a'),
    messageClass: 'handoff', priority: 'immediate', state: 'queued', revision: 0,
    stateVersion: 1, transition: 'accepted', observedAt: 1,
  },
}

/** Controlled receipt iterator: return releases a pending next without timers. */
class Receipts implements AsyncIterableIterator<MessageStateEvent> {
  pending = Promise.withResolvers<IteratorResult<MessageStateEvent>>()
  readonly returned = vi.fn(async () => {
    this.pending.resolve({ done: true, value: undefined })
    return { done: true as const, value: undefined }
  })
  next(): Promise<IteratorResult<MessageStateEvent>> { return this.pending.promise }
  return(): Promise<IteratorResult<MessageStateEvent>> { return this.returned() }
  [Symbol.asyncIterator](): AsyncIterableIterator<MessageStateEvent> { return this }
  emit(value: MessageStateEvent): void {
    const pending = this.pending
    this.pending = Promise.withResolvers<IteratorResult<MessageStateEvent>>()
    pending.resolve({ done: false, value })
  }
}

/** Service-definition substitute; arbitration and model execution remain provider-owned. */
class Delivery extends MessageDelivery {
  readonly streams: Receipts[] = []
  send = vi.fn<MessageDelivery['send']>(async request => ({
    messageId, operationId: request.operationId, deliveryOutcome: 'rejected',
    reason: 'target-not-found', messageState: 'rejected', pending: false, candidates: [],
  }))
  withdraw = vi.fn<MessageDelivery['withdraw']>(async request => ({
    messageId: request.messageId, operationId: request.operationId, kind: 'accepted-pending-owner', state: 'queued', revision: 0,
  }))
  edit = vi.fn<MessageDelivery['edit']>(request => this.withdraw(request))
  reprioritize = vi.fn<MessageDelivery['reprioritize']>(request => this.withdraw(request))
  invalidate = vi.fn<MessageDelivery['invalidate']>(request => this.withdraw(request))
  status = vi.fn<MessageDelivery['status']>(async () => status)
  operationStatus = vi.fn<MessageDelivery['operationStatus']>(async id => ({ kind: 'not-found', operationId: id }))
  list = vi.fn<MessageDelivery['list']>(async () => ({ items: [status], complete: false }))
  resolve = vi.fn<MessageDelivery['resolve']>(async () => [])
  sendBatch = vi.fn<MessageDelivery['sendBatch']>(async () => ({ kind: 'resolved', recipients: [] }))
  configure = vi.fn<MessageDelivery['configure']>(async request => request.settings)
  subscribe = vi.fn((_request: MessageSubscriptionRequest): AsyncIterable<MessageStateEvent> => {
    const stream = new Receipts()
    this.streams.push(stream)
    return stream
  })
}

function offer(selected = methods, notifications: string[] = [notification], version = 1) {
  return { protocolVersion: PROTOCOL_VERSION, _meta: { 'panedesk/messages': { version, methods: selected, notifications } } }
}

describe('ACP message extensions', () => {
  let harness: BridgeHarness | undefined
  let delivery: Delivery
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  async function start() {
    harness = await makeBridgeHarness({ setup: async (ctx) => { await ctx.plugin(Delivery); delivery = ctx.get('messageDelivery') as Delivery } })
    return harness
  }

  it('negotiates version, request intersection, and notification support', async () => {
    const h = await start()
    const initialized = await h.client.initialize(offer())
    expect(initialized._meta).toEqual({ 'panedesk/messages': { version: 1, methods, notifications: [notification] } })
    const limited = await h.client.initialize(offer([`${prefix}status`, `${prefix}subscribe`, `${prefix}unknown`], []))
    expect(limited._meta).toEqual({ 'panedesk/messages': { version: 1, methods: [`${prefix}status`], notifications: [] } })
    await expect(h.requestExtension(`${prefix}send`, send)).rejects.toMatchObject({ code: -32601, data: { reason: 'unsupported' } })
    await expect(h.requestExtension(`${prefix}status`, { messageId })).resolves.toEqual(status)
  })

  it.each([undefined, { version: 2, methods, notifications: [notification] }, { version: 1 }, null, []])(
    'does not enable extensions for absent or incompatible metadata %#', async (metadata) => {
      const h = await start()
      const result = await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, ...metadata === undefined ? {} : { _meta: { 'panedesk/messages': metadata } } })
      expect(result._meta).toBeUndefined()
      await expect(h.requestExtension(`${prefix}subscribe`, { sessionId })).rejects.toMatchObject({ code: -32601 })
      expect(delivery.subscribe).not.toHaveBeenCalled()
      expect(h.messageNotifications).toEqual([])
    },
  )

  it('returns structured unsupported without the optional service and preserves standard prompts', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('standard answer')] })
    const result = await harness.client.initialize(offer())
    expect(result._meta).toEqual({ 'panedesk/messages': { version: 1, methods: [], notifications: [], reason: 'unsupported' } })
    await expect(harness.requestExtension(`${prefix}send`, send)).rejects.toMatchObject({ code: -32601, data: { reason: 'unsupported', method: `${prefix}send` } })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'continue' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })

  it.each(['immediate', 'steer', 'queue', undefined])('forwards %s priority and an exact subagent recipient', async (priority) => {
    const h = await start()
    await h.client.initialize(offer())
    const request = { ...send, target: { sessionId: 'child-a' }, ...priority === undefined ? {} : { priority } }
    const result = await h.requestExtension(`${prefix}send`, request)
    expect(delivery.send).toHaveBeenCalledWith(request)
    expect(result).toMatchObject({ messageId, deliveryOutcome: 'rejected', reason: 'target-not-found' })
    expect(h.adapter.requests).toEqual([])
  })

  it.each([
    ['withdraw', control], ['edit', { ...control, content: 'Updated request' }],
    ['reprioritize', { ...control, priority: 'immediate' }], ['invalidate', { ...control, reason: 'Superseded' }],
    ['status', { messageId }],
    ['list', { sessionId, senderSessionId: sessionId, targetSessionId: 'child-a', nodeId: 'node-a', from: 0, to: 9, limit: 2, cursor: 'cursor-a', states: ['queued'], messageClasses: ['handoff', 'reply'], unansweredOlderThanMinutes: 5, includeTerminal: false }],
    ['resolve', { addresses: [{ name: 'seat-a' }, { nodeId: 'node-a', sessionId: 'child-a' }] }],
    ['sendBatch', { messageClass: 'reply', replyTo: messageId, content: 'Reply', recipients: [{ target: { name: 'seat-a' }, operationId }], dryRun: true }],
  ] as const)('serves %s through the optional service', async (method, request) => {
    const h = await start()
    await h.client.initialize(offer())
    const result = await h.requestExtension(`${prefix}${method}`, request)
    const expected = method === 'status' ? messageId : method === 'resolve' ? request.addresses : request
    expect(delivery[method]).toHaveBeenCalledWith(expected)
    if (method === 'list') expect(result).toEqual({ items: [status], complete: false })
    else if (method === 'status') expect(result).toEqual(status)
    else if (method === 'resolve') expect(result).toEqual([])
    else if (method === 'sendBatch') expect(result).toEqual({ kind: 'resolved', recipients: [] })
    else expect(result).toMatchObject({ kind: 'accepted-pending-owner', state: 'queued' })
  })

  it.each([
    ['send', null], ['send', []], ['send', { ...send, senderSessionId: 'forged' }],
    ['send', { ...send, target: { sessionId, name: 'seat-a' } }], ['send', { ...send, target: {} }],
    ['send', { ...send, priority: 'urgent' }], ['send', { ...send, content: ' ' }],
    ['send', { ...send, operationId: 2 }], ['send', { ...send, messageClass: 'reply' }],
    ['send', { ...send, messageClass: 'notice', priority: 'immediate' }],
    ['send', { ...send, replyTo: messageId }], ['withdraw', { ...control, expectedRevision: -1 }],
    ['edit', { ...control, content: false }], ['reprioritize', { ...control, priority: null }],
    ['invalidate', { ...control, reason: '' }], ['status', { messageId: '' }],
    ['list', { limit: 0 }], ['list', { from: 5, to: 1 }], ['list', { limit: 1.5 }],
    ['list', { states: ['read'] }], ['list', { messageClasses: ['unknown'] }], ['list', { includeTerminal: 'yes' }],
    ['subscribe', { sessionId, cursor: '' }], ['resolve', { addresses: '*' }],
    ['sendBatch', { ...send, recipients: [], dryRun: true }],
    ['sendBatch', { ...send, recipients: [{ target: { sessionId }, operationId }], dryRun: 'yes' }],
  ])('rejects invalid %s wire input %# before invoking the service', async (method, request) => {
    const h = await start()
    await h.client.initialize(offer())
    await expect(h.requestExtension(`${prefix}${method}`, request)).rejects.toMatchObject({ code: -32602 })
    expect(delivery.send).not.toHaveBeenCalled()
    expect(delivery.withdraw).not.toHaveBeenCalled()
    expect(delivery.subscribe).not.toHaveBeenCalled()
  })

  it('replays exclusive cursors on reconnect without standard output or model requests', async () => {
    const h = await start()
    await h.client.initialize(offer())
    await expect(h.requestExtension(`${prefix}subscribe`, { sessionId })).resolves.toEqual({})
    expect(delivery.subscribe).toHaveBeenCalledWith({ sessionId })
    delivery.streams[0]!.emit(event)
    await vi.waitFor(() => { expect(h.messageNotifications).toEqual([event]) })
    expect(h.updates).toEqual([])
    expect(h.adapter.requests).toEqual([])
    await h.closeClientTransport()
    await vi.waitFor(() => { expect(delivery.streams[0]!.returned).toHaveBeenCalledOnce() })
    await h.dispose()
    const reconnected = await start()
    await reconnected.client.initialize(offer())
    await expect(reconnected.requestExtension(`${prefix}subscribe`, { sessionId, cursor: event.cursor })).resolves.toEqual({ cursor: event.cursor })
    expect(delivery.subscribe).toHaveBeenCalledWith({ sessionId, cursor: event.cursor })
    const next = { ...event, cursor: brandString<MessageCursor>('cursor-b'), data: { ...event.data, state: 'injected' as const } }
    delivery.streams[0]!.emit(next)
    await vi.waitFor(() => { expect(reconnected.messageNotifications).toEqual([next]) })
  })

  it('releases pending receipt iterators on renegotiation and disposal', async () => {
    const h = await start()
    await h.client.initialize(offer())
    await h.requestExtension(`${prefix}subscribe`, { sessionId })
    await expect(h.requestExtension(`${prefix}subscribe`, { sessionId })).rejects.toMatchObject({ code: -32602 })
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION })
    expect(delivery.streams[0]!.returned).toHaveBeenCalledOnce()
    expect(h.messageNotifications).toEqual([])
    await h.client.initialize(offer())
    await h.requestExtension(`${prefix}subscribe`, { sessionId })
    await h.acpFiber.dispose()
    expect(delivery.streams[1]!.returned).toHaveBeenCalledOnce()
    await expect(h.requestExtension(`${prefix}status`, { messageId })).rejects.toMatchObject({ code: -32603 })
  })

  it('preserves unsupported session/load after extension negotiation', async () => {
    const h = await start()
    await h.client.initialize(offer())
    await expect(h.requestExtension('session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })).rejects.toMatchObject({ code: -32601 })
  })
})
