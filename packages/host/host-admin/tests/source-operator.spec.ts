/** Source administration delegates only after local operator authorization. */
import { expect, test, vi } from 'vitest'
import { join } from 'node:path'
import type * as Seat from '@panedesk/dsh-seat'
import { harness } from '../../../seat/seat-engine/tests/fixtures.ts'
import { Context } from '@panedesk/cordis'
import { mountAdmin } from '../src/runtime.ts'
import { PosixPrivateFiles } from '../src/private-files.ts'
import { callHostAdmin } from '../src/sdk-client.ts'
import { decodeRequest, decodeResponse } from '../src/codec.ts'
import { createHostAdminExecutor } from '../src/executor.ts'
import { digest } from '../src/json.ts'
import { HOST_ADMIN_VERSION, HOST_ADMIN_METHODS, inject } from '../src/index.ts'
import type { HostAdminAuthority, HostAdminGrant, HostAdminSourceOperator, SourceOperatorItem } from '../src/index.ts'

const params = { operationId: 'source-a', key: 'original:prepared:key', reason: 'Operator reviewed evidence' }
const item: SourceOperatorItem = { key: params.key, state: 'awaiting-manual', eventId: 'event-a', target: 'seat-a',
  since: '2026-01-01T00:00:00.000Z', ticket: 'ticket-a', detail: 'Awaiting an operator' }
const frame = (method: 'source.operations' | 'source.abandon' | 'source.resend', input: unknown = params) => decodeRequest({
  version: HOST_ADMIN_VERSION, requestId: 'request-a', processEpoch: 'epoch-a', nonce: 'nonce-a', method, params: input,
})
const authority: HostAdminAuthority = { principalId: 'operator-a' as Seat.SeatPrincipalId,
  authorizationRef: 'authority-a' as Seat.AuthorizationRef, kind: 'local-operator', methods: HOST_ADMIN_METHODS }
const resultFrame = (request: ReturnType<typeof frame>, result: unknown) => ({ version: HOST_ADMIN_VERSION,
  requestId: request.requestId, method: request.method, status: 'ok', result })
function setup(provider?: HostAdminSourceOperator) {
  const fact: HostAdminGrant['fact'] = { authorizationId: authority.authorizationRef, kind: 'local-operator',
    principalId: authority.principalId, origin: 'manual', nodeId: 'node-a' as Seat.SeatNodeId, taskIds: [],
    operationId: params.operationId as Seat.SeatOperationId, policyRevision: 1, decision: 'allowed', reasonCode: 'allowed',
    requestDigest: digest(params) as Seat.SeatDigest, checkedAt: new Date().toISOString() }
  let grant = { fact } as HostAdminGrant
  const check = vi.fn(async () => grant)
  const authorize = vi.fn(async () => ({ check }))
  const executor = createHostAdminExecutor({ nodeId: fact.nodeId, policy: { authorize },
    engine: {} as Seat.SeatEngineService, authorization: {} as Seat.SeatAuthorizationTransactions,
    queries: {} as Seat.SeatAuthorizationQueries, ...(provider ? { sourceOperator: provider } : {}) })
  return { executor, check, authorize, fact, get grant() { return grant },
    patch(patch: Partial<HostAdminGrant['fact']>) { grant = { fact: { ...fact, ...patch } } as HostAdminGrant } }
}

test('lists provider items unchanged and returns unavailable without a provider', async () => {
  const result = { items: [item] }
  const list = vi.fn(async () => result)
  const provider: HostAdminSourceOperator = { list, abandon: async () => ({ status: 'ok' }) }
  const h = setup(provider)
  const request = frame('source.operations', { limit: 200 })
  const response = await h.executor.execute(request, authority)
  expect(response).toMatchObject({ status: 'ok', result })
  if (response.status === 'ok' && response.method === 'source.operations') expect(response.result).toBe(result)
  expect(list).toHaveBeenCalledWith({ limit: 200 })
  expect(h.check).not.toHaveBeenCalled()
  expect(await h.executor.execute(request, { ...authority, methods: [] })).toMatchObject({ code: 'admin-unauthorized' })
  for (const method of ['source.operations', 'source.abandon', 'source.resend'] as const) {
    expect(await setup().executor.execute(frame(method, method === 'source.operations' ? {} : params), authority))
      .toMatchObject({ status: 'unavailable', code: 'admin-method-unavailable' })
  }
  expect(inject).not.toContain('hostAdminSourceOperator')
})

test.each(['source.abandon', 'source.resend'] as const)('%s requires every grant binding and passes the original grant', async (method) => {
  const write = vi.fn(async (_params: typeof params, _grant: HostAdminGrant) => ({ status: 'ok' as const, generation: 2 }))
  const h = setup({ list: async () => ({ items: [] }), abandon: write, resend: write })
  const request = frame(method)
  for (const denied of [{ ...authority, kind: 'node-delegation' as const }, { ...authority, methods: [] }]) {
    expect(await h.executor.execute(request, denied)).toMatchObject({ status: 'rejected', code: 'admin-unauthorized' })
  }
  expect(h.authorize).not.toHaveBeenCalled()
  for (const patch of [{ nodeId: 'other' as Seat.SeatNodeId }, { principalId: 'other' as Seat.SeatPrincipalId },
    { operationId: 'other' as Seat.SeatOperationId }, { requestDigest: 'other' as Seat.SeatDigest },
    { kind: 'node-delegation' as const }, { decision: 'denied' as const }]) {
    h.patch(patch)
    expect(await h.executor.execute(request, authority)).toMatchObject({ code: 'admin-unauthorized' })
  }
  expect(write).not.toHaveBeenCalled()
  h.patch({})
  expect(await h.executor.execute(request, authority)).toMatchObject({ status: 'ok', result: { status: 'ok', generation: 2 } })
  expect(h.check).toHaveBeenLastCalledWith({ operationId: params.operationId, requestDigest: digest(params) })
  expect(write).toHaveBeenCalledWith(params, h.grant)
  expect(write.mock.calls[0]?.[1]).toBe(h.grant)
})

test('returns unavailable when the source owner does not implement resend', async () => {
  const h = setup({ list: async () => ({ items: [] }), abandon: async () => ({ status: 'ok' }) })
  expect(await h.executor.execute(frame('source.resend'), authority))
    .toMatchObject({ status: 'unavailable', code: 'admin-method-unavailable' })
  expect(h.check).not.toHaveBeenCalled()
})

test('rejects source request length limits and unknown fields without changing cancellation identifiers', () => {
  for (const method of ['source.abandon', 'source.resend'] as const) {
    for (const patch of [{ key: '' }, { key: 'k'.repeat(513) }, { reason: '' }, { reason: 'r'.repeat(501) },
      { operationId: '' }, { operationId: ' ' }, { extra: true }, { key: 1 }, { reason: null }]) {
      expect(() => frame(method, { ...params, ...patch })).toThrow()
    }
    expect(frame(method, { ...params, key: 'k'.repeat(512), reason: 'r'.repeat(500), operationId: 'o'.repeat(513) }).params)
      .toMatchObject({ key: 'k'.repeat(512) })
    expect(frame(method, { ...params, key: 'k', reason: 'r' })).toBeDefined()
  }
  for (const input of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: '1' }, { extra: true }, null]) {
    expect(() => frame('source.operations', input)).toThrow()
  }
  for (const input of [{}, { limit: 1 }, { limit: 200 }]) expect(frame('source.operations', input)).toBeDefined()
  expect(() => decodeRequest({ ...frame('source.operations', {}), extra: true })).toThrow()
})

test('validates registered provider detail codes without accepting arbitrary error text', () => {
  const request = frame('source.operations', {})
  const response = { version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method,
    status: 'unavailable', code: 'admin-unavailable', reason: 'source-settlement-pending', detail: 'source-settlement-pending' }
  expect(decodeResponse(response, request)).toBe(response)
  expect(() => decodeResponse({ ...response, detail: 'private-error-text' }, request)).toThrow()
})

test('rejects source result overflow invalid state and unknown fields at every level', () => {
  const request = frame('source.operations', {})
  const valid = resultFrame(request, { items: [item] })
  expect(decodeResponse(valid, request)).toBe(valid)
  for (const patch of [{ state: 'unknown' }, { extra: true }, { key: 'k'.repeat(513) }, { eventId: 'e'.repeat(513) },
    { target: 't'.repeat(513) }, { ticket: 't'.repeat(513) }, { detail: 'd'.repeat(2001) }, { since: 'not-a-time' }]) {
    expect(() => decodeResponse(resultFrame(request, { items: [{ ...item, ...patch }] }), request)).toThrow()
  }
  expect(() => decodeResponse(resultFrame(request, { items: Array.from({ length: 201 }, () => item) }), request)).toThrow()
  expect(() => decodeResponse(resultFrame(request, { items: [], extra: true }), request)).toThrow()
  expect(() => decodeResponse({ ...valid, extra: true }, request)).toThrow()
  expect(decodeResponse(resultFrame(request, { items: Array.from({ length: 200 }, () => ({ ...item,
    state: 'parked-none', key: 'k'.repeat(512), detail: 'd'.repeat(2000) })) }), request)).toBeDefined()
  for (const method of ['source.abandon', 'source.resend'] as const) {
    const write = frame(method)
    for (const result of [{ status: 'unknown' }, { status: 'ok', generation: 0 }, { status: 'ok', generation: 1.5 },
      { status: 'ok', generation: Number.MAX_SAFE_INTEGER + 1 }, { status: 'ok', extra: true },
      { status: 'ok', code: 'c'.repeat(513) }, { status: 'rejected', reason: 'r'.repeat(513) },
      { status: 'ok', effect: 'none' }, { status: 'rejected', effect: 'partial' }]) {
      expect(() => decodeResponse(resultFrame(write, result), write)).toThrow()
    }
    for (const result of [{ status: 'ok' }, { status: 'rejected', code: 'c'.repeat(512), reason: 'r'.repeat(512), generation: 1 },
      { status: 'rejected', code: 'write-budget-exceeded-before-write', reason: 'write-budget-exceeded-before-write', effect: 'none' }]) {
      expect(decodeResponse(resultFrame(write, result), write)).toBeDefined()
    }
  }
})

test('preserves all six existing method frames byte for byte', () => {
  const frames = [
    ['node.status', {}, { nodeId: 'node-a', nodeName: 'node-a', engine: 'running', openEngineWindows: 0, limit: 1, readyAt: null }],
    ['engine.pending', { limit: 10 }, { items: [], watermark: 0, complete: true }],
    ['engine.approve', { operationId: 'operation-a', queueItemId: 'queue-a', expectedStateVersion: 1 }, { status: 'approved', queueItemId: 'queue-a', stateVersion: 2 }],
    ['engine.cancel', { operationId: 'operation-a', queueItemId: 'queue-a', expectedStateVersion: 1 }, { status: 'cancelled', queueItemId: 'queue-a', stateVersion: 2 }],
    ['engine.operation', { operationId: 'operation-a' }, { status: 'missing' }],
    ['engine.query', { limit: 10 }, { effects: [], complete: true, watermark: 0 }],
  ] as const
  for (const [method, input, result] of frames) {
    const original = { version: HOST_ADMIN_VERSION, requestId: 'request-a', nonce: 'nonce-a', processEpoch: 'epoch-a', method, params: input }
    const request = decodeRequest(original)
    expect(JSON.stringify(request)).toBe(JSON.stringify(original))
    const output = resultFrame(request, result)
    expect(JSON.stringify(decodeResponse(output, request))).toBe(JSON.stringify(output))
  }
})

test('calls a source provider through loopback and the running engine issuer with durable replay', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  let stop: (() => Promise<void>) | undefined
  const list = vi.fn(async () => ({ items: [item] }))
  const write = vi.fn(async (_params: typeof params, grant: HostAdminGrant) => {
    expect(grant.fact).toMatchObject({ kind: 'local-operator', nodeId: 'node-a', principalId: 'operator-a',
      operationId: _params.operationId, requestDigest: digest(_params), decision: 'allowed' })
    return { status: 'ok' as const, generation: 2 }
  })
  try {
    h.ctx.provide('hostAdminSourceOperator', { list, abandon: write, resend: write })
    const directory = join(h.home, 'source-admin')
    const limits = { maxFrameBytes: 65536, requestTimeoutMs: 5000, maxPending: 8 }
    stop = await mountAdmin(h.ctx, { runtime: { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a',
      port: 0, maxStoreBytes: 1048576, maxOperations: 100 } })
    const files = new PosixPrivateFiles(directory, process.getuid!())
    expect(await callHostAdmin(files, 'source.operations', { limit: 10 }, limits)).toMatchObject({ status: 'ok', result: { items: [item] } })
    for (const method of ['source.abandon', 'source.resend'] as const) {
      const target = { ...params, operationId: method }
      expect(await callHostAdmin(files, method, target, limits)).toMatchObject({ status: 'ok', result: { status: 'ok', generation: 2 } })
      expect(await callHostAdmin(files, method, target, limits)).toMatchObject({ status: 'ok' })
    }
    expect(write).toHaveBeenCalledTimes(2)
    const endpoint = JSON.parse((await files.read('endpoint.json', 4096))!) as { processEpoch: string }
    const forged = decodeRequest({ ...frame('source.abandon'), processEpoch: endpoint.processEpoch })
    expect(await h.ctx.get('hostAdmin')!.dispatch(forged, authority)).toMatchObject({ code: 'admin-unauthorized' })
    expect(await h.ctx.get('hostAdmin')!.dispatch(forged, { ...authority, kind: 'node-delegation' }))
      .toMatchObject({ code: 'admin-unauthorized' })
  } finally { await stop?.(); await h.close() }
})

test('returns unavailable over loopback without source capabilities and lists without an engine', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  const ctx = new Context()
  let stop: (() => Promise<void>) | undefined
  try {
    const directory = join(h.home, 'optional-source-admin')
    const limits = { maxFrameBytes: 65536, requestTimeoutMs: 5000, maxPending: 8 }
    stop = await mountAdmin(ctx, { runtime: { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a',
      port: 0, maxStoreBytes: 1048576, maxOperations: 100 } })
    const files = new PosixPrivateFiles(directory, process.getuid!())
    for (const method of ['source.operations', 'source.abandon', 'source.resend'] as const) {
      expect(await callHostAdmin(files, method, method === 'source.operations' ? {} : { ...params, operationId: method }, limits))
        .toMatchObject({ status: 'unavailable', code: 'admin-method-unavailable' })
    }
    ctx.provide('hostAdminSourceOperator', { list: async () => ({ items: [item] }), abandon: async () => ({ status: 'ok' }) })
    expect(await callHostAdmin(files, 'source.operations', {}, limits)).toMatchObject({ status: 'ok', result: { items: [item] } })
    expect(await callHostAdmin(files, 'source.resend', { ...params, operationId: 'no-resend' }, limits))
      .toMatchObject({ status: 'unavailable', code: 'admin-method-unavailable' })
  } finally { await stop?.(); await ctx.fiber.dispose(); await h.close() }
})
