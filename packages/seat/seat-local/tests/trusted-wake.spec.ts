/** Trusted wakes retain one window admission and one persistent delivery per wire identity. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import type { NodeWireRequest } from '@panedesk/dsh-node-link'
import { frozenHost, sender, principalId } from './frozen-fixture.ts'
import { digest } from '../src/store.ts'

async function setup(existing = true) {
  const f = await frozenHost(), { h, registry } = f
  await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
  const definition = await h.seats.resolve(h.definition.seat)
  if ('status' in definition) throw new Error('Expected seat')
  await h.seats.save({ definition: { ...definition, wakeTemplate: { kind: 'text', text: 'Trusted wake' } },
    expectedRevision: 3, operationId: 'wake-template' as T.SeatOperationId })
  if (existing) {
    const opened = await h.seats.open({ seat: definition.seat, operationId: 'existing-window' as T.SeatOperationId,
      origin: 'manual', openingMode: 'prefill' })
    expect(opened.status).toBe('prefilled')
  }
  const payload = (id: string): T.WakeFrozenSeatRequest => {
    const base = f.request(id as T.SeatOperationId)
    return { ...base, request: { seat: definition.seat, operationId: id as T.SeatOperationId } }
  }
  const invoke = async (request: T.WakeFrozenSeatRequest) => h.ctx.get('seats')!
    .withAuthority(await f.authorize(request, request.request.operationId)).wakeFrozen!(request)
  return { ...f, payload, invoke }
}

test('authorized existing-window wake sends once and replays the first receipt after reload and input conflict', async () => {
  const { h, registry, payload, invoke, authorize } = await setup()
  try {
    const request = payload('wake-success'), delivery = h.ctx.get('messageDelivery')!
    const send = vi.spyOn(delivery, 'send')
    const first = await invoke(request)
    expect(first).toMatchObject({ status: 'sent', operationId: request.request.operationId })
    expect(await invoke(request)).toEqual(first)
    expect(send).toHaveBeenCalledTimes(1)
    const query: T.NodeWorkChainOperationRequest = { key: { method: 'seat.wakeFrozen', sourceNodeId: sender, principalId,
      sourceId: request.route.sourceId, ownerEpoch: request.route.ownerEpoch, operationId: request.request.operationId },
    payloadDigest: digest(request) }
    expect(await registry.query(query, await authorize(query, 'query-wake' as T.SeatOperationId)))
      .toEqual({ status: 'settled', method: 'seat.wakeFrozen', result: first })
    const changed = { ...request, openingContext: { ...request.openingContext, openingMode: 'auto' as const } }
    expect(await invoke(changed)).toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
    await h.reload()
    await expect.poll(() => Boolean(registry.resolve('seat.wakeFrozen'))).toBe(true)
    await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
    expect(await invoke(request)).toEqual(first)
    expect(send).toHaveBeenCalledTimes(1)
    const retained = await authorize(request, request.request.operationId)
    h.engine.authorizationIssuers.close()
    expect(await h.ctx.get('seats')!.withAuthority(retained).wakeFrozen!(request)).toEqual(first)
    expect(h.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'node-wake/updated')).toHaveLength(2)
  } finally { vi.restoreAllMocks(); await h.close() }
})

test('revoked wake authority and altered input admit no delivery', async () => {
  const { h, payload, authorize } = await setup()
  try {
    const request = payload('wake-revoked'), authority = await authorize(request, request.request.operationId)
    const send = vi.spyOn(h.ctx.get('messageDelivery')!, 'send')
    expect(await h.ctx.get('seats')!.withAuthority(authority).wakeFrozen!({ ...request, request: {
      ...request.request, operationId: 'changed' as T.SeatOperationId } })).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    h.engine.authorizationIssuers.close()
    expect(await h.ctx.get('seats')!.withAuthority(authority).wakeFrozen!(request))
      .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(send).not.toHaveBeenCalled()
    expect(h.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'node-wake/updated')).toHaveLength(0)
  } finally { vi.restoreAllMocks(); await h.close() }
})

test('concurrent missing-window frozen wakes share opening admission and preserve its first queue receipt', async () => {
  const { h, payload, invoke } = await setup(false)
  try {
    const first = payload('wake-first'), second = payload('wake-second')
    const results = await Promise.all([invoke(first), invoke(second)])
    expect(results[0]).toMatchObject({ status: 'opened', result: { status: 'queued' } })
    expect(results[1]).toMatchObject({ status: 'opened', result: { status: 'rejected', error: { code: 'session-busy' } } })
    expect(await invoke(first)).toEqual(results[0])
    expect(h.engine.journal.projection.pending.size).toBe(1)
    expect(h.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'node-route/accepted')).toHaveLength(1)
  } finally { await h.close() }
})

test.each([true, false])('explicit node wake composition preserves existing-window=%s and refuses missing snapshots', async (existing) => {
  const { h, authorize } = await setup(existing)
  try {
    const payload: T.WakeSeatRequest = { seat: h.definition.seat, operationId: 'legacy-wake' as T.SeatOperationId }
    const authority = await authorize(payload, payload.operationId), grant = authority.authorization
    const request: Extract<NodeWireRequest, { method: 'seat.wake' }> = { version: 'node-link/v1', method: 'seat.wake',
      requestId: 'wake-request' as NodeWireRequest['requestId'], operationId: payload.operationId,
      sourceNodeId: sender, targetNodeId: h.options.nodeId, payload, payloadDigest: digest(payload),
      deadline: '2099-01-01T00:00:00.000Z', hop: 1, delegation: { kind: 'node-delegation', hop: 1, principalId,
        authorizationRef: grant.fact.authorizationId, sourceNodeId: sender, targetNodeId: h.options.nodeId,
        operationId: payload.operationId, requestDigest: digest(payload), taskIds: [], expiresAt: '2099-01-01T00:00:00.000Z' } }
    const result = await h.ctx.get('nodeAuthorizedLocalAdmission')!.execute(request, grant)
    expect(result).toMatchObject(existing ? { status: 'ok', result: { status: 'sent' } }
      : { status: 'ok', result: { status: 'opened', result: { status: 'rejected', error: { code: 'cross-node-unsupported' } } } })
    if (existing) expect(await h.ctx.get('nodeAuthorizedLocalAdmission')!.execute(request, grant)).toEqual(result)
    else expect(h.engine.journal.projection.pending.size).toBe(0)
  } finally { await h.close() }
})
