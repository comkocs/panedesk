/** Real ingress commits original business identity and recovers its exact first acknowledgement. */
import { expect, test, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { harness, nodeId, sourceId, seat, trigger } from './fixtures.ts'
import { digest } from '../src/journal.ts'
import { frozenIdentity, queryFrozen } from '../src/frozen-admission.ts'

function request(): T.AcceptFrozenTriggerRequest {
  const envelope = trigger(), operationId = 'frozen-operation' as T.SeatOperationId
  const ownerEpoch = 'owner-epoch' as T.OwnerEpoch, owner = 'owner-node' as T.SeatNodeId
  const snapshot: T.OpeningContextSnapshot = { reference: { providerId: 'provider' as T.OpeningProviderId,
    reference: 'reference' as T.OpeningContextReference['reference'], revision: '1' }, text: 'Frozen text',
  digest: digest('Frozen text'), revision: '1', taskIds: [], scopeEvidence: [] }
  return { envelope, expectedSeatRevision: 1, openingContext: { snapshot, openingMode: 'auto', scopeReservation: {
    reservationId: 'reservation' as T.NodeWorkChainScopeReservation['reservationId'], sourceId, sourceOwnerNodeId: owner,
    ownerEpoch, operationId, taskIds: [], snapshotDigest: snapshot.digest, policyRevision: 1 } },
  route: { sourceId, sourceOwnerNodeId: owner, ownerEpoch, triggerId: envelope.triggerId, originalOperationId: operationId,
    targetNodeId: nodeId, snapshotDigest: snapshot.digest, callbackPath: { kind: 'source', sourceId },
    modeCeiling: { mode: 'remind', policy: { sourceId, projectId: envelope.projectId, revision: 1 } } } }
}

async function setup() {
  const h = await harness({ ownerObserveIntervalMs: 60000 }), input = request(), sender = 'sending-node' as T.SeatNodeId
  const principalId = 'principal' as T.SeatPrincipalId
  h.definitions.get(seat)!.remoteAdmission = { allowOpen: true, sourceNodeIds: [sender], sourceIds: [sourceId],
    principalIds: [principalId], methods: ['engine.acceptFrozen'], policyRevision: 1 }
  const authorize = async (payload: T.AcceptFrozenTriggerRequest | T.OpenFrozenSeatRequest = input,
    engine = h.engine, sourceNodeId: T.SeatNodeId | undefined = sender) => {
    const entry = engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
      nodeId, origin: 'remote', seat, taskIds: [], policyRevision: 1, ...(sourceNodeId ? { sourceNodeId } : {}) },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
    const grant = await entry.issuer.check({ operationId: payload.route.originalOperationId, requestDigest: digest(payload) })
    if ('status' in grant) throw new Error('Expected grant')
    return { principalId, nodeId, origin: 'remote' as const, authorization: grant }
  }
  return { h, input, authorize }
}

test('admits a missing replay once and returns its result to the late original after restart', async () => {
  const { h, input, authorize } = await setup()
  try {
    const original = structuredClone(input), authority = await authorize()
    const key: T.NodeWorkChainOperationKey = { sourceNodeId: authority.authorization.fact.sourceNodeId!,
      principalId: authority.principalId, sourceId: input.route.sourceId, ownerEpoch: input.route.ownerEpoch,
      method: 'engine.acceptFrozen', operationId: input.route.originalOperationId }
    const query = { key, payloadDigest: digest(input) }
    expect(queryFrozen(h.engine.journal.projection, query)).toEqual({ status: 'missing' })
    const replay = await h.engine.acceptFrozen(input, authority)
    expect(replay).toMatchObject({ status: 'accepted' })
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(await restarted.acceptFrozen(original, await authorize(original, restarted))).toEqual(replay)
    expect(queryFrozen(restarted.journal.projection, query)).toEqual({ status: 'settled', method: key.method, result: replay })
    expect(restarted.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'trigger/accepted')).toHaveLength(1)
  } finally { await h.close() }
})

test('returns the original frozen acceptance on concurrent retry and after recovery', async () => {
  const { h, input, authorize } = await setup()
  try {
    const authority = await authorize()
    const results = await Promise.all([h.engine.acceptFrozen(input, authority), h.engine.acceptFrozen(input, await authorize())])
    expect(results[0]).toMatchObject({ status: 'accepted' })
    expect(results[1]).toEqual(results[0])
    expect(h.engine.journal.projection.authorizationDecisions).toHaveLength(1)
    expect(h.engine.journal.projection.authorizationDecisions[0]?.effects.map(effect => effect.kind))
      .toEqual(['trigger/accepted', 'node-route/accepted', 'queue/reminded', 'authorization/checked'])
    const accepted = h.engine.journal.projection.authorizationDecisions[0]?.effects.find(effect => effect.kind === 'node-route/accepted')
    if (accepted?.kind !== 'node-route/accepted') throw new Error('Expected admission')
    expect(accepted.data.operationKey.sourceNodeId).not.toBe(accepted.data.route.sourceOwnerNodeId)
    const query = { key: accepted.data.operationKey, payloadDigest: digest(input) }
    expect(queryFrozen(h.engine.journal.projection, query)).toEqual({ status: 'settled', method: 'engine.acceptFrozen', result: results[0] })
    const changed = { ...input, envelope: { ...input.envelope, data: 'changed', dataDigest: digest('changed') } }
    expect(await h.engine.acceptFrozen(changed, await authorize(changed))).toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
    expect(queryFrozen(h.engine.journal.projection, { ...query, payloadDigest: digest(changed) })).toMatchObject({ status: 'rejected' })
    h.definitions.clear()
    h.engine.authorizationIssuers.close()
    expect(await h.engine.acceptFrozen(input, authority)).toEqual(results[0])
    expect(await h.engine.acceptFrozen(changed, { ...authority, authorization: {
      ...authority.authorization, fact: { ...authority.authorization.fact, requestDigest: digest(changed) } } }))
      .toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
    await h.engine.shutdown()
    await writeFile(join(h.engine.journal.root, 'events', '9999999999999999-interrupted.jsonl'), '{"sequence":2')
    const restarted = await h.start()
    expect(queryFrozen(restarted.journal.projection, query)).toEqual({ status: 'settled', method: 'engine.acceptFrozen', result: results[0] })
    expect(await restarted.acceptFrozen(input, await authorize(input, restarted))).toEqual(results[0])
    expect(restarted.journal.projection.authorizationDecisions).toHaveLength(1)
  } finally { await h.close() }
})

test('revokes new frozen writes before shutdown drains an admitted call', async () => {
  const { h, input, authorize } = await setup()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  try {
    const authority = await authorize()
    const resolve = h.seatProvider.resolve.bind(h.seatProvider)
    vi.spyOn(h.seatProvider, 'resolve').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return resolve(...args)
    })
    const active = h.engine.acceptFrozen(input, authority)
    await entered.promise
    let drained = false
    const closing = h.engine.shutdown().then(() => { drained = true })
    expect(await h.engine.acceptFrozen(input, authority)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    expect(drained).toBe(false)
    release.resolve(undefined)
    expect(await active).toMatchObject({ status: 'accepted' })
    await closing
    expect(await h.engine.acceptFrozen(input, authority)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
  } finally { release.resolve(undefined); vi.restoreAllMocks(); await h.close() }
})

function executionAccess(h: Awaited<ReturnType<typeof harness>>, recheck = vi.fn(async (): Promise<T.SeatRejected | null> => null)) {
  return { list: () => h.seatProvider.list(), close: (input: T.CloseSeatRequest) => h.seatProvider.close(input),
    freeze: async (definition: T.SeatDefinition) => ({ definition, title: 'Frozen', openingMode: 'auto' as const }), recheck }
}

async function admitForExecution(kind: 'remote-source' | 'owner-target') {
  const setupResult = await setup(), { h, input, authorize } = setupResult
  const recheck = vi.fn(async (): Promise<T.SeatRejected | null> => null)
  h.engine.registerLocalAccess(executionAccess(h, recheck))
  if (kind === 'owner-target') {
    input.route.sourceOwnerNodeId = nodeId
    input.openingContext.scopeReservation.sourceOwnerNodeId = nodeId
    const payload: T.OpenFrozenSeatRequest = { request: { seat, operationId: input.route.originalOperationId,
      origin: 'remote', openingMode: 'auto' }, expectedSeatRevision: input.expectedSeatRevision,
    openingContext: input.openingContext, route: { ...input.route, triggerId: null } }
    h.definitions.get(seat)!.remoteAdmission!.methods = ['seat.openFrozen']
    const authority = await authorize(payload), chain = frozenIdentity(payload, authority, 'seat.openFrozen')
    if ('status' in chain) throw new Error('Expected frozen identity')
    expect(await h.engine.openWindow({ request: payload.request, authority, nodeWorkChain: chain,
      definition: structuredClone(h.definitions.get(seat)!), title: 'Frozen', openingContext: payload.openingContext.snapshot,
      opening: { text: payload.openingContext.snapshot.text, digest: payload.openingContext.snapshot.digest,
        variables: { seat, date: '2026-01-01', taskId: null } } })).toMatchObject({ status: 'queued' })
  } else {
    expect(await h.engine.acceptFrozen(input, await authorize())).toMatchObject({ status: 'accepted' })
  }
  const pending = [...h.engine.journal.projection.pending.values()][0]!
  const query = { key: pending.frozenOpen!.nodeWorkChain!.operationKey,
    payloadDigest: pending.frozenOpen!.nodeWorkChain!.payloadDigest }
  const original = queryFrozen(h.engine.journal.projection, query)
  return { ...setupResult, recheck, pending, query, original }
}

async function approveForExecution(h: Awaited<ReturnType<typeof harness>>, pending: T.PendingSeatItem) {
  expect(await h.engine.approve({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
    operationId: 'approve-a' as T.SeatOperationId })).toMatchObject({ status: 'approved' })
}

test.each(['remote-source', 'owner-target'] as const)('refuses a changed frozen target revision before dispatch for %s', async (kind) => {
  const { h, pending, query, original, recheck } = await admitForExecution(kind)
  try {
    await h.engine.drive()
    expect(h.creates).toEqual([])
    h.definitions.get(seat)!.revision++
    await approveForExecution(h, h.engine.journal.projection.pending.get(pending.queueItemId)!)
    await h.engine.drive()
    expect(h.creates).toEqual([])
    expect(h.engine.journal.projection.pending.size).toBe(0)
    expect(h.engine.journal.projection.opens.size).toBe(0)
    expect(h.engine.journal.projection.resources.size).toBe(0)
    expect(h.engine.journal.projection.decisions.flatMap(item => item.effects)
      .filter(effect => effect.kind === 'open/rejected')).toMatchObject([
      { kind: 'open/rejected', data: { error: { code: 'revision-conflict', effectState: 'none' }, candidates: [] } } ])
    expect(pending.frozenOpen!.nodeWorkChain!.expectedSeatRevision).toBe(1)
    expect(queryFrozen(h.engine.journal.projection, query)).toEqual(original)
    expect(recheck).toHaveBeenCalledTimes(1)
  } finally { await h.close() }
})

test.each(['sourceNodeIds', 'sourceIds', 'principalIds', 'methods', 'missing'] as const)(
  'refuses frozen execution when remote admission removes %s without changing the seat revision', async (field) => {
    const { h, pending, query, original } = await admitForExecution('remote-source')
    try {
      const definition = h.definitions.get(seat)!, policy = definition.remoteAdmission!
      if (field === 'missing') delete definition.remoteAdmission
      else policy[field] = []
      await approveForExecution(h, pending)
      await h.engine.drive()
      expect(h.creates).toEqual([])
      expect(h.engine.journal.projection.pending.size).toBe(0)
      expect(h.engine.journal.projection.decisions.flatMap(item => item.effects)
        .filter(effect => effect.kind === 'open/rejected')).toMatchObject([
        { kind: 'open/rejected', data: { error: { code: 'unauthorized', effectState: 'none' }, candidates: [] } } ])
      expect(queryFrozen(h.engine.journal.projection, query)).toEqual(original)
    } finally { await h.close() }
  })

test.each(['remote-source', 'owner-target'] as const)('executes unchanged frozen permission once without renewing the original grant for %s', async (kind) => {
  const { h, pending, query, original, recheck } = await admitForExecution(kind)
  try {
    h.engine.authorizationIssuers.close()
    await approveForExecution(h, pending)
    await h.engine.drive()
    await h.engine.drive()
    expect(h.creates).toHaveLength(1)
    expect(h.engine.journal.projection.opens.size).toBe(1)
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(queryFrozen(h.engine.journal.projection, query)).toEqual(original)
    const frames = structuredClone(h.engine.journal.projection.authorizationDecisions)
    await h.engine.shutdown()
    const restarted = await h.start()
    restarted.registerLocalAccess(executionAccess(h))
    await restarted.drive()
    expect(h.creates).toHaveLength(1)
    expect(restarted.journal.projection.authorizationDecisions).toEqual(frames)
    expect(queryFrozen(restarted.journal.projection, query)).toEqual(original)
  } finally { await h.close() }
})

test.each(['revision', 'permission'] as const)('rechecks the frozen target after asynchronous source policy changes %s', async (change) => {
  const { h, pending, recheck } = await admitForExecution('owner-target')
  try {
    recheck.mockImplementation(async () => {
      if (change === 'revision') h.definitions.get(seat)!.revision++
      else delete h.definitions.get(seat)!.remoteAdmission
      return null
    })
    await approveForExecution(h, pending)
    await h.engine.drive()
    expect(h.creates).toEqual([])
    expect(h.engine.journal.projection.opens.size).toBe(0)
  } finally { await h.close() }
})

test('rechecks the frozen target after dispatch commits and before creating a window', async () => {
  const { h, pending } = await admitForExecution('owner-target')
  try {
    h.ctx.on('seat/decision', (decision) => {
      if (decision.effects.some(effect => effect.kind === 'open/intent')) h.definitions.get(seat)!.revision++
    })
    await approveForExecution(h, pending)
    await h.engine.drive()
    expect(h.creates).toEqual([])
    expect([...h.engine.journal.projection.opens.values()]).toMatchObject([
      { phase: 'opening-failed', failure: { code: 'revision-conflict', effectState: 'none' } } ])
    expect(h.engine.journal.projection.resources.size).toBe(0)
  } finally { await h.close() }
})

test('rechecks the frozen target after restart before unfinished configuration or opening', async () => {
  const { h, pending, query, original } = await admitForExecution('owner-target')
  try {
    h.executor.configure = async () => { throw new Error('Interrupted configuration') }
    await approveForExecution(h, pending)
    await expect(h.engine.drive()).rejects.toThrow('Interrupted configuration')
    expect(h.creates).toHaveLength(1)
    const frames = structuredClone(h.engine.journal.projection.authorizationDecisions)
    await h.engine.shutdown()
    h.definitions.get(seat)!.revision++
    const configure = vi.fn(async () => {}), opening = vi.spyOn(h.executor, 'opening')
    h.executor.configure = configure
    const restarted = await h.start()
    restarted.registerLocalAccess(executionAccess(h))
    await restarted.drive()
    expect(configure).not.toHaveBeenCalled()
    expect(opening).not.toHaveBeenCalled()
    expect(h.creates).toHaveLength(1)
    expect(restarted.journal.projection.authorizationDecisions).toEqual(frames)
    expect(queryFrozen(restarted.journal.projection, query)).toEqual(original)
  } finally { await h.close() }
})

test('refuses missing sender, forged grants and denied target policies without admission', async () => {
  const { h, input, authorize } = await setup()
  try {
    const valid = await authorize()
    const missing = { ...valid.authorization.fact }
    delete missing.sourceNodeId
    expect(await h.engine.acceptFrozen(input, { ...valid, authorization: { ...valid.authorization, fact: missing } }))
      .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(await h.engine.acceptFrozen(input, { ...valid, authorization: { ...valid.authorization } }))
      .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    delete h.definitions.get(seat)!.remoteAdmission
    expect(await h.engine.acceptFrozen(input, valid)).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(h.engine.journal.projection.sequence).toBe(0)
  } finally { await h.close() }
})
