/** Real ingress commits original business identity and recovers its exact first acknowledgement. */
import { expect, test, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { harness, nodeId, sourceId, seat, trigger } from './fixtures.ts'
import { digest } from '../src/journal.ts'
import { queryFrozen } from '../src/frozen-admission.ts'

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
  const h = await harness(), input = request(), sender = 'sending-node' as T.SeatNodeId
  const principalId = 'principal' as T.SeatPrincipalId
  h.definitions.get(seat)!.remoteAdmission = { allowOpen: true, sourceNodeIds: [sender], sourceIds: [sourceId],
    principalIds: [principalId], methods: ['engine.acceptFrozen'], policyRevision: 1 }
  const authorize = async (payload = input, engine = h.engine, sourceNodeId: T.SeatNodeId | undefined = sender) => {
    const entry = engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
      nodeId, origin: 'remote', seat, taskIds: [], policyRevision: 1, ...(sourceNodeId ? { sourceNodeId } : {}) },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
    const grant = await entry.issuer.check({ operationId: payload.route.originalOperationId, requestDigest: digest(payload) })
    if ('status' in grant) throw new Error('Expected grant')
    return { principalId, nodeId, origin: 'remote' as const, authorization: grant }
  }
  return { h, input, authorize }
}

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
