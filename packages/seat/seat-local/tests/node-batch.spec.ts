/** Optional node batch admission preflights all members and retains independent committed results. */
import { expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import type { NodeWireRequest } from '@panedesk/dsh-node-link'
import { digest, EngineError } from '@panedesk/dsh-seat-engine'
import { processFixture, methods, sender, principalId } from './frozen-process-fixture.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'node-batch-'))
  const h = await processFixture(root)
  await h.registry.ready(methods)
  const second = { ...h.definition, seat: 'seat-b' as T.SeatName }
  const local = h.ctx.get('seats')!.withAuthority({ principalId, nodeId: h.definition.node as T.SeatNodeId, origin: 'manual' })
  const catalog = await local.definitions({})
  await local.save({ definition: second, expectedRevision: catalog.revision, operationId: 'second-seat' as T.SeatOperationId })
  const request: T.OpenSeatBatchRequest = { seats: [h.definition.seat, second.seat], origin: 'remote',
    operationId: 'batch' as T.SeatOperationId, nodeId: 'node-a' as T.SeatNodeId }
  const authorize = async (payload: T.OpenSeatBatchRequest) => ({ grant: { fact: {
    authorizationId: 'batch-entry' as T.AuthorizationRef, taskIds: [], kind: 'node-delegation', principalId,
    nodeId: h.engine.options.nodeId, sourceNodeId: sender, origin: payload.origin, policyRevision: 1,
    operationId: payload.operationId, requestDigest: digest(payload), checkedAt: new Date().toISOString(),
    decision: 'allowed', reasonCode: 'fixture',
  } } as Pick<T.SeatAuthorizationGrant, 'fact'> as T.SeatAuthorizationGrant })
  const run = (payload: T.OpenSeatBatchRequest, grant: T.SeatAuthorizationGrant) => {
    const wire: Extract<NodeWireRequest, { method: 'seat.openBatch' }> = { version: 'node-link/v1', requestId: 'request' as NodeWireRequest['requestId'],
      sourceNodeId: sender, targetNodeId: 'node-a' as T.SeatNodeId, operationId: payload.operationId,
      deadline: '2099-01-01T00:00:00.000Z', hop: 1, method: 'seat.openBatch', payload, payloadDigest: digest(payload),
      delegation: { kind: 'node-delegation', hop: 1, principalId, authorizationRef: grant.fact.authorizationId,
        sourceNodeId: sender, targetNodeId: 'node-a' as T.SeatNodeId, operationId: payload.operationId,
        requestDigest: digest(payload), expiresAt: '2099-01-01T00:00:00.000Z', taskIds: grant.fact.taskIds } }
    return h.ctx.get('nodeAuthorizedLocalAdmission')!.execute(wire, grant)
  }
  return { ...h, request, authorize, run,
    close: async () => { await h.close(); await rm(root, { recursive: true, force: true }) } }
}

test('retains a committed member and returns the same members on replay', async () => {
  const h = await fixture()
  try {
    const entry = await h.authorize(h.request)
    const partial = await h.run(h.request, entry.grant)
    expect(partial).toMatchObject({ status: 'ok', result: { status: 'processed', results: [
      { seat: 'seat-a', result: { status: 'queued' } }, { seat: 'seat-b', result: { status: 'queued' } }] } })
    const replacement = await h.authorize(h.request)
    const resumed = await h.run(h.request, replacement.grant)
    expect(resumed).toMatchObject({ status: 'ok', result: { status: 'processed', results: [
      { result: { status: 'queued' } }, { result: { status: 'queued' } }] } })
    if (partial.status !== 'ok' || partial.method !== 'seat.openBatch' || partial.result.status !== 'processed'
      || resumed.status !== 'ok' || resumed.method !== 'seat.openBatch' || resumed.result.status !== 'processed') throw new Error('Expected member results')
    expect(resumed.result.results[0]).toEqual(partial.result.results[0])
    expect(await h.run(h.request, replacement.grant)).toEqual(resumed)
    const frames = h.engine.journal.projection.authorizationDecisions.filter(frame => frame.effects.some(effect => effect.kind === 'node-batch/accepted'))
    expect(frames).toHaveLength(2)
    expect(frames.map(frame => frame.effects.map(effect => effect.kind))).toEqual(Array.from({ length: 2 }, () => [
      'trigger/accepted', 'node-batch/accepted']))
    const changed = { ...h.request, seats: [h.definition.seat] }
    expect(await h.run(changed, (await h.authorize(changed)).grant)).toMatchObject({ status: 'ok', result: {
      status: 'rejected', error: { code: 'operation-id-conflict' } } })
  } finally { await h.close() }
})

test.each(['missing-member', 'duplicate-member', 'foreign-node', 'changed-origin'] as const)(
  'preflights the complete batch without side effects: %s', async (kind) => {
    const h = await fixture()
    try {
      const request = structuredClone(h.request)
      if (kind === 'missing-member') request.seats = [...request.seats, 'missing-seat' as T.SeatName]
      if (kind === 'duplicate-member') request.seats = [...request.seats, h.definition.seat]
      if (kind === 'foreign-node') request.nodeId = sender
      const entry = await h.authorize(request)
      if (kind === 'changed-origin') request.origin = 'manual'
      const sequence = h.engine.journal.projection.sequence
      const member = vi.spyOn(h.engine, 'openBatchMember')
      expect(await h.run(request, entry.grant)).toMatchObject(kind === 'changed-origin'
        ? { status: 'rejected', error: { code: 'node-delegation-rejected' } }
        : { status: 'ok', result: { status: 'rejected' } })
      expect(member).not.toHaveBeenCalled()
      expect(h.engine.journal.projection.sequence).toBe(sequence)
      expect(h.engine.journal.projection.pending.size).toBe(0)
      expect(h.engine.journal.projection.opens.size).toBe(0)
    } finally { vi.restoreAllMocks(); await h.close() }
  })

test('returns a member storage failure without discarding a committed predecessor', async () => {
  const h = await fixture()
  try {
    const entry = await h.authorize(h.request)
    const commit = h.engine.journal.commitAuthorization.bind(h.engine.journal)
    let calls = 0
    vi.spyOn(h.engine.journal, 'commitAuthorization').mockImplementation((...args) => {
      if (++calls === 2) throw new EngineError('unavailable', 'Injected member storage failure')
      return commit(...args)
    })
    expect(await h.run(h.request, entry.grant)).toMatchObject({ status: 'ok', result: { status: 'processed', results: [
      { seat: 'seat-a', result: { status: 'queued' } },
      { seat: 'seat-b', result: { status: 'rejected', error: { code: 'unavailable', effectState: 'unknown' } } }] } })
    expect(h.engine.journal.projection.pending.size).toBe(1)
    expect(h.engine.journal.projection.authorizationDecisions.filter(frame =>
      frame.effects.some(effect => effect.kind === 'node-batch/accepted'))).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await h.close() }
})
