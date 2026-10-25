/** Exclusive providers must recover before business absence can become observable. */
import { Context } from '@panedesk/cordis'
import { expect, test, vi } from 'vitest'
import type { NodeWorkChainBusinessProvider, NodeWorkChainOperationRequest, SeatCallContext } from '@panedesk/dsh-seat'
import { ChainBusinessRegistry } from '../src/chain-business.ts'
import { decodeChainRequest, chainDigest } from '../src/chain-codec.ts'
import { chainKey } from '../src/chain-identity.ts'

function query(): NodeWorkChainOperationRequest {
  const payload = { sourceId: 'source-a', sourceOwnerNodeId: 'node-b', ownerEpoch: 'owner-a',
    reference: { providerId: 'provider-a', reference: 'opening-a', revision: '1' }, seat: 'seat-a', taskIds: ['task-a'],
    operationId: 'operation-a', targetNodeId: 'node-a', expectedSeatRevision: 1, openingMode: 'prefill' }
  const request = decodeChainRequest({ version: 'node-link/v1', requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId: 'operation-a', deadline: '2099-01-01T00:00:00.000Z', hop: 1, method: 'source.prepareOpening', payload,
    payloadDigest: chainDigest('source.prepareOpening', payload), delegation: { kind: 'node-delegation', hop: 1,
      principalId: 'principal-a', authorizationRef: 'grant-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
      operationId: 'operation-a', requestDigest: chainDigest('source.prepareOpening', payload), taskIds: ['task-a'],
      expiresAt: '2099-01-01T00:00:00.000Z' } })
  return { key: chainKey(request), payloadDigest: request.payloadDigest }
}
const input = query()
const context: SeatCallContext = { principalId: input.key.principalId, origin: 'engine', nodeId: input.key.sourceNodeId }

function provider(): NodeWorkChainBusinessProvider {
  return { methods: ['source.prepareOpening'], ready: async () => {}, query: async () => ({ status: 'missing' }) }
}

test('rejects duplicate providers atomically and removes effect-owned registrations on disposal', async () => {
  const registry = new ChainBusinessRegistry(), first = provider(), ctx = new Context()
  try {
    ctx.effect(() => registry.register(first))
    expect(() => registry.register(first)).toThrow('conflict')
    expect(() => registry.register({ ...first, methods: ['source.checkAdmission', 'source.prepareOpening'] })).toThrow('conflict')
    expect(registry.resolve('source.checkAdmission')).toBeUndefined()
    await registry.ready(first.methods)
    expect(registry.isReady(first.methods)).toBe(true)
  } finally { await ctx.fiber.dispose() }
  expect(registry.resolve('source.prepareOpening')).toBeUndefined()
  expect(registry.isReady(first.methods)).toBe(false)
})

test('queries the business source only after recovery and never calls optional resume', async () => {
  const registry = new ChainBusinessRegistry(), first = provider()
  let finish!: () => void
  const recovery = new Promise<void>((resolve) => { finish = resolve })
  const read = vi.fn((request: NodeWorkChainOperationRequest, authority: SeatCallContext) => first.query(request, authority))
  const resume = vi.fn((request: NodeWorkChainOperationRequest, authority: SeatCallContext) => first.query(request, authority))
  registry.register({ ...first, ready: () => recovery, query: read, resume })
  const ready = registry.ready(first.methods)
  expect(await registry.query(input, context)).toEqual({ status: 'pending', effectState: 'unknown' })
  expect(read).not.toHaveBeenCalled()
  finish(); await ready
  expect(await registry.query(input, context)).toEqual({ status: 'missing' })
  expect(read).toHaveBeenCalledExactlyOnceWith(input, context)
  expect(resume).not.toHaveBeenCalled()
})

test('rejects missing or failed recovery and invalidates a query when its provider is withdrawn', async () => {
  const registry = new ChainBusinessRegistry(), first = provider()
  await expect(registry.ready(first.methods)).rejects.toThrow('unavailable')
  const remove = registry.register({ ...first, ready: async () => { throw new Error('Recovery failed') } })
  await expect(registry.ready(first.methods)).rejects.toThrow('Recovery failed')
  expect(registry.isReady(first.methods)).toBe(false)
  remove()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const withdraw = registry.register({ ...first, query: async () => { await pending; return { status: 'missing' } } })
  await registry.ready(first.methods)
  const result = registry.query(input, context)
  withdraw(); release()
  expect(await result).toEqual({ status: 'pending', effectState: 'unknown' })
})
