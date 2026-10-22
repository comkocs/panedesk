/** Message extension routing uses a provider substitute and the real SDK session owner. */
import { Context, Service } from '@panedesk/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import * as JsonlSessionPersistence from '@panedesk/dsh-session-persistence-jsonl'
import { decodeMessagesResult, type MessageDelivery, type MessagesRequestMap, type MessageStateEvent } from '@panedesk/dsh-sdk-protocol'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

const receipt = {
  cursor: 'cursor-a', nodeId: 'node-a', data: {
    messageId: 'message-a', senderSessionId: 'seat-a', targetSessionId: 'seat-b', priority: 'steer',
    messageClass: 'handoff', state: 'queued', revision: 0, stateVersion: 1, operationId: 'operation-a',
    transition: 'accepted', observedAt: 1,
  },
} as const
const status = { messageId: 'message-a', state: 'queued', phase: 'pending', revision: 0, stateVersion: 1, transitions: [receipt] }
const recipient = { nodeId: 'node-a', sessionId: 'seat-b', window: 'window-a', title: 'seat-b', status: 'idle', matchedFields: ['sessionId'], observedAt: 1 }
const control = { messageId: 'message-a', operationId: 'operation-a', expectedRevision: 0 }
const sent = { messageId: 'message-a', operationId: 'operation-a', deliveryOutcome: 'accepted', messageState: 'queued', pending: false, recipient }
const settings = { receiveMode: 'all', wakeOnHandoff: true }
const cases = [
  ['send', { target: { sessionId: 'seat-b' }, content: 'work', messageClass: 'handoff', operationId: 'operation-a' }, sent],
  ['withdraw', control, { ...control, kind: 'applied', status }],
  ['edit', { ...control, content: 'updated' }, { ...control, kind: 'applied', status }],
  ['reprioritize', { ...control, priority: 'immediate' }, { ...control, kind: 'applied', status }],
  ['invalidate', { ...control, reason: 'superseded' }, { ...control, kind: 'applied', status }],
  ['status', { messageId: 'message-a' }, status],
  ['operationStatus', { operationId: 'operation-a' }, { kind: 'not-found', operationId: 'operation-a' }],
  ['list', { sessionId: 'seat-a' }, { items: [status], complete: true }],
  ['resolve', { addresses: [{ sessionId: 'seat-b' }] }, [{ kind: 'resolved', address: { sessionId: 'seat-b' }, recipient }]],
  ['sendBatch', { content: 'work', messageClass: 'handoff', recipients: [{ target: { sessionId: 'seat-b' }, operationId: 'operation-a' }], dryRun: false }, { kind: 'sent', results: [sent] }],
  ['configure', { sessionId: 'seat-a', settings }, settings],
] as const

class Delivery extends Service implements MessageDelivery {
  static inject = ['agents']
  readonly calls: { method: string; request: unknown; sender: string | undefined }[] = []
  fail = false
  returned = 0
  constructor(ctx: Context) { super(ctx, 'messageDelivery') }
  private result<M extends keyof MessagesRequestMap>(method: M, request: unknown): Promise<MessagesRequestMap[M]['result']> {
    this.calls.push({ method, request, sender: this.ctx.agents.currentInitiator()?.session.id })
    if (this.fail) return Promise.reject(new Error('storage unavailable'))
    const entry = cases.find(([name]) => `messages/${name}` === method)
    return Promise.resolve(decodeMessagesResult(method, entry?.[2]))
  }
  send: MessageDelivery['send'] = request => this.result('messages/send', request)
  withdraw: MessageDelivery['withdraw'] = request => this.result('messages/withdraw', request)
  edit: MessageDelivery['edit'] = request => this.result('messages/edit', request)
  reprioritize: MessageDelivery['reprioritize'] = request => this.result('messages/reprioritize', request)
  invalidate: MessageDelivery['invalidate'] = request => this.result('messages/invalidate', request)
  status: MessageDelivery['status'] = request => this.result('messages/status', request)
  operationStatus: MessageDelivery['operationStatus'] = request => this.result('messages/operationStatus', request)
  list: MessageDelivery['list'] = request => this.result('messages/list', request)
  resolve: MessageDelivery['resolve'] = async request => [...await this.result('messages/resolve', request)]
  sendBatch: MessageDelivery['sendBatch'] = request => this.result('messages/sendBatch', request)
  configure: MessageDelivery['configure'] = request => this.result('messages/configure', request)
  subscribe: MessageDelivery['subscribe'] = (request) => {
    this.calls.push({ method: 'messages/subscribe', request, sender: this.ctx.agents.currentInitiator()?.session.id })
    let emitted = false
    const pending = Promise.withResolvers<IteratorResult<MessageStateEvent>>()
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (this.fail) throw new Error('receipt storage unavailable')
          if (emitted) return pending.promise
          emitted = true
          const decoded = decodeMessagesResult('messages/status', { ...status, transitions: [{ ...receipt, cursor: request.cursor === undefined ? 'cursor-a' : 'cursor-b' }] })
          return { done: false, value: decoded.transitions[0]! }
        },
        return: async () => { this.returned++; pending.resolve({ done: true, value: undefined }); return { done: true, value: undefined } },
      }),
    }
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup(enabled = true, version: number | undefined = 1) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-messages-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('answer')]))
  if (enabled) await ctx.plugin(Delivery)
  const notifications: { method: string; params?: object }[] = []
  const server = new HarnessSdkJsonRpcServer(ctx, {
    request: async () => ({}),
    notify: (method, params) => { notifications.push({ method, ...params === undefined ? {} : { params } }) },
  })
  cleanups.push(() => server.shutdown().then(() => undefined))
  const initialized = await server.initialize({ cwd: root, provider: 'mock', model: 'mock', ...version === undefined ? {} : { messagesVersion: version } })
  await server.getWorkingDirectory({ sessionId: 'seat-a' })
  return { ctx, server, notifications, initialized, delivery: ctx.get('messageDelivery') as Delivery | undefined }
}

describe('SDK message provider adapter', () => {
  it.each(cases)('routes %s and propagates provider failures', async (name, params, result) => {
    const { server, delivery, initialized } = await setup()
    expect(initialized.messagesVersion).toBe(1)
    expect(await server.handleRequest(`messages/${name}`, { ...params })).toEqual(result)
    const expected = name === 'status' && 'messageId' in params ? params.messageId
      : name === 'operationStatus' && 'operationId' in params ? params.operationId
        : name === 'resolve' && 'addresses' in params ? params.addresses : params
    expect(delivery?.calls.at(-1)).toEqual({ method: `messages/${name}`, request: expected, sender: undefined })
    delivery!.fail = true
    await expect(server.handleRequest(`messages/${name}`, { ...params })).rejects.toThrow('storage unavailable')
  })

  it.each([false, true])('does not advertise unavailable or unnegotiated delivery (%s)', async (enabled) => {
    const { server, initialized } = await setup(enabled, enabled ? 2 : 1)
    expect(initialized.messagesVersion).toBeUndefined()
    for (const name of [...cases.map(entry => entry[0]), 'subscribe']) {
      await expect(server.handleRequest(`messages/${name}`, {})).rejects.toMatchObject({ code: -32601, data: { reason: 'unsupported' } })
    }
  })

  it('takes sender identity from an owned invocation and rejects wire impersonation', async () => {
    const { server, ctx, delivery } = await setup()
    const request = { ...cases[0][1] }
    await ctx.agents.withInitiator(ctx.agents.get(SessionId('seat-a'))!, () => server.handleRequest('messages/send', request))
    expect(delivery?.calls.at(-1)?.sender).toBe('seat-a')
    await expect(server.handleRequest('messages/send', { ...request, senderSessionId: 'seat-b' })).rejects.toThrow('parameters')
    await expect(server.handleRequest('messages/configure', { sessionId: 'seat-b', settings })).rejects.toMatchObject({ data: { reason: 'unauthorized' } })
    await expect(server.handleRequest('messages/subscribe', { sessionId: 'seat-b' })).rejects.toMatchObject({ data: { reason: 'unauthorized' } })
  })

  it('replays after the requested cursor and releases replaced and shutdown streams', async () => {
    const { server, notifications, delivery } = await setup()
    await expect(server.handleRequest('messages/subscribe', { sessionId: 'seat-a' })).resolves.toEqual({})
    await vi.waitFor(() => { expect(notifications.filter(item => item.method === 'messages.state')).toHaveLength(1) })
    await expect(server.handleRequest('messages/subscribe', { sessionId: 'seat-a', cursor: 'cursor-a' })).resolves.toEqual({ cursor: 'cursor-a' })
    await vi.waitFor(() => { expect(notifications.filter(item => item.method === 'messages.state')).toHaveLength(2) })
    expect(notifications.filter(item => item.method === 'messages.state').map(item => item.params)).toEqual([receipt, { ...receipt, cursor: 'cursor-b' }])
    await server.shutdown()
    expect(delivery?.returned).toBe(2)
  })

  it('reports receipt storage failure rather than leaving a silent stream', async () => {
    const { server, notifications, delivery } = await setup()
    delivery!.fail = true
    await server.handleRequest('messages/subscribe', { sessionId: 'seat-a' })
    await vi.waitFor(() => {
      expect(notifications).toContainEqual({ method: 'messages.error', params: { sessionId: 'seat-a', reason: 'unavailable' } })
    })
  })
})
