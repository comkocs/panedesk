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

test.each(['source', 'owner', 'revoked', 'grant', 'opening-grant', 'digest'] as const)('rejects a local owner wake with invalid %s evidence', async (damage) => {
  const { h } = await setup()
  try {
    const request: T.WakeSeatRequest = { seat: h.definition.seat, operationId: 'local-owner-rejected' as T.SeatOperationId }
    const entry = h.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
      nodeId: h.options.nodeId, sourceNodeId: damage === 'source' ? sender : h.options.nodeId,
      origin: 'manual', seat: request.seat, taskIds: [], policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: damage === 'owner' ? 'generic-human' : 'trusted-local-owner', policyRevision: 1 }) })
    const grant = await entry.issuer.check({ operationId: request.operationId, requestDigest: digest(request) })
    const opening = await entry.issuer.check({ operationId: request.operationId,
      requestDigest: digest(damage === 'digest' ? request : { ...request, origin: 'manual', openingMode: 'auto' }) })
    if ('status' in grant || 'status' in opening) throw new Error('Expected test grants')
    const authority: T.SeatCallContext = { principalId, nodeId: h.options.nodeId, origin: 'manual',
      ...(damage === 'grant' ? {} : { authorization: grant }), localWake: { opening } }
    if (damage === 'opening-grant') authority.localWake = { opening: { ...opening } }
    if (damage === 'revoked') entry.dispose()
    const send = vi.spyOn(h.ctx.get('messageDelivery')!, 'send')
    expect(await h.ctx.get('seats')!.withAuthority(authority).wake(request)).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(send).not.toHaveBeenCalled()
    expect(h.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'node-wake/updated')).toHaveLength(0)
    entry.dispose()
  } finally { vi.restoreAllMocks(); await h.close() }
})

test.each([true, false])('local owner wake preserves its delivery or opening identity after provider reload with an existing window=%s', async (existing) => {
  const { h, registry } = await setup(existing)
  const request: T.WakeSeatRequest = { seat: h.definition.seat, operationId: 'local-owner-replay' as T.SeatOperationId }
  const invoke = async () => {
    const entry = h.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
      nodeId: h.options.nodeId, sourceNodeId: h.options.nodeId, origin: 'manual', seat: request.seat, taskIds: [], policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: 'trusted-local-owner', policyRevision: 1 }) })
    try {
      const authorization = await entry.issuer.check({ operationId: request.operationId, requestDigest: digest(request) })
      const opening = await entry.issuer.check({ operationId: request.operationId,
        requestDigest: digest({ ...request, origin: 'manual', openingMode: 'auto' }) })
      if ('status' in authorization || 'status' in opening) throw new Error('Expected owner grants')
      return await h.ctx.get('seats')!.withAuthority({ principalId, nodeId: h.options.nodeId,
        origin: 'manual', authorization, localWake: { opening } }).wake(request)
    } finally { entry.dispose() }
  }
  try {
    const send = vi.spyOn(h.ctx.get('messageDelivery')!, 'send')
    const first = await invoke()
    expect(first).toMatchObject(existing ? { status: 'sent' } : { status: 'opened', result: { status: 'opened' } })
    const count = send.mock.calls.length
    const identity = (result: T.WakeSeatResult) => {
      if (result.status !== 'opened' || result.result.status !== 'opened') return result
      const { stateVersion: _version, ...window } = result.result
      return { ...result, result: window }
    }
    expect(identity(await invoke())).toEqual(identity(first))
    await h.reload()
    await expect.poll(() => Boolean(registry.resolve('seat.wakeFrozen'))).toBe(true)
    await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
    expect(identity(await invoke())).toEqual(identity(first))
    expect(send).toHaveBeenCalledTimes(count)
    if (!existing) expect(h.engine.journal.projection.opens.size).toBe(1)
  } finally { vi.restoreAllMocks(); await h.close() }
})

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

test('queries a missing-window frozen wake execution without replacing its admission receipt', async () => {
  const { h, registry, payload, invoke, authorize } = await setup(false)
  const removeScope = h.ctx.get('seatOpeningContexts')!.registerScopeAdmission!({
    evaluateTaskScopes: async () => ({ outcome: 'allow', revisions: [] }),
    batch: (_request, _authority, execute) => execute(), open: (_request, _authority, execute) => execute(),
    recheck: async () => null,
  })
  let removeRetention: (() => Promise<void>) | undefined
  try {
    const request = payload('wake-execution-query')
    removeRetention = h.engine.registerPreopenRetention({ sourceId: request.route.sourceId,
      sourceOwnerNodeId: request.route.sourceOwnerNodeId, limitMs: 900000 })
    const first = await invoke(request)
    expect(first).toMatchObject({ status: 'opened', result: { status: 'queued' } })
    const pending = [...h.engine.journal.projection.pending.values()][0]
    if (!pending) throw new Error('Expected frozen wake admission')
    expect(await h.engine.approve({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
      operationId: 'approve-wake-query' as T.SeatOperationId })).toMatchObject({ status: 'approved' })
    await h.engine.drive()
    const open = [...h.engine.journal.projection.opens.values()][0]
    if (!open) throw new Error('Expected retained wake opening')
    const query: T.NodeWorkChainOperationRequest = { key: { method: 'seat.wakeFrozen', sourceNodeId: sender, principalId,
      sourceId: request.route.sourceId, ownerEpoch: request.route.ownerEpoch, operationId: request.request.operationId },
    payloadDigest: digest(request) }
    expect(await registry.query(query, await authorize(query, 'query-wake-execution' as T.SeatOperationId)))
      .toMatchObject({ status: 'settled', method: 'seat.wakeFrozen', result: {
        status: 'opened', result: { sessionId: open.sessionId, phase: open.phase } } })
    expect(await invoke(request)).toEqual(first)
    expect(h.engine.journal.projection.opens.size).toBe(1)
  } finally { await removeRetention?.(); await removeScope(); await h.close() }
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
