/** Callback attempts use the real chain router and a deterministic source-owner substitute. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import type { ChainRequest } from '@panedesk/dsh-node-link'
import { chainKey } from '@panedesk/dsh-node-link/src/chain-identity.ts'
import { CallbackOutbox } from '@panedesk/dsh-seat-engine/src/outbox.ts'
import { SourceRegistry } from '@panedesk/dsh-seat-engine/src/sources.ts'
import { deliverRoutedCallback, queryRoutedCallback } from '@panedesk/dsh-seat-engine/src/routed-callback.ts'
import { config, harness, seat } from '../../seat-engine/tests/fixtures.ts'
import { admittedDefinition, loopback, persistCallback, response, services } from './routed-callback-fixture.ts'

async function setup() {
  const h = await harness(), seen: ChainRequest[] = [], checks: T.SeatAuthorizationCheck[] = []
  h.definitions.set(seat, admittedDefinition())
  const body = await persistCallback(h.engine)
  const state = { result: { status: 'committed', callbackId: body.callback.callbackId,
    payloadDigest: body.payloadDigest } as T.DeliverSourceCallbackResult,
  query: { status: 'missing' } as T.NodeWorkChainOperationResult, lose: false }
  const link = await loopback(h.home, h.engine.options.nodeId, async (request) => {
    seen.push(request)
    if (request.method === 'chain.operation') return response(request, state.query)
    if (request.method !== 'source.deliverCallback') throw new Error('Unexpected method')
    if (state.lose) { state.lose = false; throw new Error('Lost response') }
    return response(request, state.result)
  })
  const sources = new SourceRegistry(), local = vi.fn(async () => {})
  sources.register({ sourceId: body.callback.sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: local })
  const composition = services(() => h.engine, checks)
  h.ctx.provide('nodeWorkChain', composition); h.ctx.provide('nodeWorkChainRouter', link.router)
  const outbox = new CallbackOutbox(h.engine.journal, sources, config,
    (input, observation) => deliverRoutedCallback(h.ctx, h.engine, input, observation))
  return { h, body, state, link, seen, checks, local, composition, outbox,
    delivery: () => h.engine.journal.projection.callbacks.get(body.callback.callbackId)!,
    observation: () => outbox.observations().find(item => item.payload.callbackId === body.callback.callbackId)!,
    async close() { await outbox.close(); await sources.close(); await link.close(); await h.close() } }
}

test.each(['committed', 'pending', 'authentication', 'protocol', 'other'] as const)(
  'records the owner %s result without local fallback', async (kind) => {
    const f = await setup()
    try {
      if (kind === 'pending') f.state.result = { status: 'pending', callbackId: f.body.callback.callbackId, payloadDigest: f.body.payloadDigest }
      if (!['pending', 'committed'].includes(kind)) f.state.result = { status: 'rejected', error: {
        code: kind === 'authentication' ? 'unauthorized' : kind === 'protocol' ? 'callback-protocol-error' : 'unavailable',
        message: 'Owner refusal', alternative: 'Review owner state', retryable: false, effectState: 'none' } }
      await f.outbox.deliver(0)
      const expected = { phase: kind === 'committed' ? 'delivered'
        : ['authentication', 'protocol'].includes(kind) ? 'paused' : 'retry-due',
      responseClass: kind === 'committed' ? 'success' : kind === 'pending' || kind === 'other' ? 'transient' : kind }
      expect(f.observation()).toMatchObject({ ...expected, attempt: 1 })
      if (kind === 'pending' || kind === 'other') {
        expect(f.delivery()).toMatchObject({ phase: 'pending', responseClass: 'unknown', attempt: 0, nextDue: null })
        const sequence = f.h.engine.journal.projection.sequence
        await f.outbox.close()
        expect(f.h.engine.journal.projection.sequence).toBe(sequence + 1)
        expect(f.delivery()).toMatchObject({ ...expected, attempt: 1, nextDue: new Date(1).toISOString(),
          retrySummary: { count: 1, firstAttemptAt: new Date(0).toISOString(), lastAttemptAt: new Date(0).toISOString() } })
      } else expect(f.delivery()).toMatchObject({ ...expected, attempt: 1, nextDue: null })
      expect(f.local).not.toHaveBeenCalled()
      expect(f.seen.map(item => item.method)).toEqual(['chain.operation', 'source.deliverCallback'])
      expect(f.seen[1]).toMatchObject({ payload: f.body, payloadDigest: f.body.payloadDigest,
        operationId: f.body.route.originalOperationId })
      expect(f.seen[0]?.delegation.authorizationRef).not.toBe(f.seen[1]?.delegation.authorizationRef)
    } finally { await f.close() }
  })

test('missing issuer retains transient retries without transport or local callbacks', async () => {
  const f = await setup()
  try {
    f.composition.outboxIssuer = async () => undefined
    await f.outbox.deliver(0)
    expect(f.delivery()).toMatchObject({ phase: 'retry-due', responseClass: 'transient' })
    expect(f.seen).toEqual([]); expect(f.local).not.toHaveBeenCalled()
  } finally { await f.close() }
})

test('disconnection retains exponential backoff and restores one same-key delivery', async () => {
  const f = await setup()
  try {
    f.link.state.connected = false
    await f.outbox.deliver(0)
    await f.outbox.deliver(0)
    expect(f.delivery()).toMatchObject({ attempt: 1, nextDue: new Date(1).toISOString() })
    const first = structuredClone(f.delivery()), sequence = f.h.engine.journal.projection.sequence
    await f.outbox.deliver(1)
    expect(f.observation()).toMatchObject({ phase: 'retry-due', responseClass: 'transient', attempt: 2,
      nextDue: new Date(3).toISOString() })
    expect(f.delivery()).toEqual(first)
    expect(f.h.engine.journal.projection.sequence).toBe(sequence)
    f.link.state.connected = true
    await f.outbox.deliver(2)
    expect(f.seen).toEqual([])
    await f.outbox.deliver(3)
    await f.outbox.deliver(100)
    expect(f.delivery()).toMatchObject({ phase: 'delivered', responseClass: 'success', attempt: 3, nextDue: null,
      retrySummary: { count: 2, firstAttemptAt: new Date(0).toISOString(), lastAttemptAt: new Date(1).toISOString() } })
    expect(f.seen.filter(item => item.method === 'source.deliverCallback')).toHaveLength(1)
  } finally { await f.close() }
})

test.each(['missing', 'pending', 'committed'] as const)('queries an unknown transport outcome before %s recovery', async (kind) => {
  const f = await setup()
  try {
    f.state.lose = true
    const route = f.link.router.route.bind(f.link.router)
    vi.spyOn(f.link.router, 'route').mockImplementation(async (request, grant) => {
      const result = await route(request, grant)
      if (request.method === 'source.deliverCallback' && result.status !== 'ok') {
        f.state.query = kind === 'missing' ? { status: 'missing' } : kind === 'pending' ? { status: 'pending', effectState: 'unknown' }
          : { status: 'settled', method: 'source.deliverCallback', result: f.state.result }
      }
      return result
    })
    await f.outbox.deliver(0)
    const writes = f.seen.filter(item => item.method === 'source.deliverCallback')
    expect(writes).toHaveLength(1)
    expect(f.seen.map(item => item.method)).toEqual(['chain.operation', 'source.deliverCallback', 'chain.operation'])
    if (kind !== 'committed') {
      expect(f.delivery().responseClass).toBe('unknown')
      expect(await f.h.engine.authorizations.operation({ operationId: f.body.route.originalOperationId })).toMatchObject({
        status: 'pending', progress: { kind: 'pending', blockedBy: ['callback-outcome-unknown'] },
      })
      const barrier = structuredClone(f.delivery()), sequence = f.h.engine.journal.projection.sequence
      expect(barrier).toMatchObject({ phase: 'pending', responseClass: 'unknown', attempt: 0, nextDue: null })
      await f.outbox.deliver(100)
      expect(f.seen.filter(item => item.method === 'source.deliverCallback')).toHaveLength(1)
      expect(f.delivery()).toEqual(barrier)
      expect(f.h.engine.journal.projection.sequence).toBe(sequence)
      expect(f.observation()).toMatchObject({ phase: 'retry-due', responseClass: 'unknown', attempt: 2,
        nextDue: new Date(102).toISOString() })
      await f.outbox.close()
      expect(f.h.engine.journal.projection.sequence).toBe(sequence + 1)
      expect(f.delivery()).toMatchObject({ phase: 'retry-due', responseClass: 'unknown', attempt: 2,
        retrySummary: { count: 2, firstAttemptAt: new Date(0).toISOString(), lastAttemptAt: new Date(100).toISOString() } })
    } else expect(f.delivery()).toMatchObject({ phase: 'delivered', responseClass: 'success', attempt: 1, nextDue: null })
    expect(f.seen.filter(item => item.method === 'chain.operation').every(item => item.payload.key.callbackId === f.body.callback.callbackId)).toBe(true)
  } finally { vi.restoreAllMocks(); await f.close() }
})

test('read-only issuer lookup matches every complete-key component and returns detached evidence', async () => {
  const f = await setup()
  try {
    await f.outbox.deliver(0)
    const sent = f.seen.find(item => item.method === 'source.deliverCallback')!
    const query = { key: chainKey(sent), payloadDigest: f.body.payloadDigest }, sequence = f.h.engine.journal.projection.sequence
    const retained = await queryRoutedCallback(f.h.engine, query)
    expect(retained).toEqual(f.body)
    retained!.modelEvidence.observedAt = '2000-01-01T00:00:00Z'
    expect(await queryRoutedCallback(f.h.engine, query)).toEqual(f.body)
    for (const field of ['sourceNodeId', 'principalId', 'sourceId', 'ownerEpoch', 'method', 'operationId', 'callbackId'] as const) {
      expect(await queryRoutedCallback(f.h.engine, { ...query, key: { ...query.key, [field]: 'other' } })).toBeUndefined()
    }
    expect(await queryRoutedCallback(f.h.engine, { ...query, payloadDigest: 'other' as T.SeatDigest })).toBeUndefined()
    expect(f.h.engine.journal.projection.sequence).toBe(sequence)
  } finally { await f.close() }
})
