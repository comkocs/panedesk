/** Loader-owned local admission preserves frozen acknowledgements and exact business queries. */
import { expect, test } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { ChainBusinessRegistry } from '@panedesk/dsh-node-link/src/chain-business.ts'
import { admissionHost } from './admission-host.ts'
import { digest } from '../src/store.ts'

const sender = 'sending-node' as T.SeatNodeId, principalId = 'remote-principal' as T.SeatPrincipalId
async function setup() {
  const h = await admissionHost()
  const registry = new ChainBusinessRegistry()
  h.ctx.provide('nodeWorkChainBusiness', registry)
  const definition = { ...h.definition, remoteAdmission: { allowOpen: true as const, sourceNodeIds: [sender],
    sourceIds: ['remote-source' as T.SeatSourceId], principalIds: [principalId],
    methods: ['seat.openFrozen', 'seat.wakeFrozen', 'engine.acceptFrozen'] as T.SeatRemoteOpeningMethod[], policyRevision: 1 } }
  await h.seats.save({ definition, expectedRevision: 2, operationId: 'save-remote' as T.SeatOperationId })
  await h.ctx.loader.await()
  const request = (operationId: T.SeatOperationId): T.OpenFrozenSeatRequest => {
    const sourceId = definition.remoteAdmission.sourceIds[0]!, ownerEpoch = 'owner-epoch' as T.OwnerEpoch
    const owner = 'owner-node' as T.SeatNodeId
    const snapshot: T.OpeningContextSnapshot = { reference: { providerId: 'absent-provider' as T.OpeningProviderId,
      reference: 'reference' as T.OpeningContextReference['reference'], revision: '1' }, text: 'Frozen source text',
    digest: digest('Frozen source text'), revision: '1', taskIds: [], scopeEvidence: [] }
    return { request: { seat: definition.seat, operationId, origin: 'remote' }, expectedSeatRevision: definition.revision,
      openingContext: { snapshot, openingMode: 'prefill', scopeReservation: {
        reservationId: 'reservation' as T.NodeWorkChainScopeReservation['reservationId'], sourceId, sourceOwnerNodeId: owner,
        ownerEpoch, operationId, taskIds: [], snapshotDigest: snapshot.digest, policyRevision: 1 } },
      route: { sourceId, sourceOwnerNodeId: owner, ownerEpoch, triggerId: null, originalOperationId: operationId,
        targetNodeId: h.options.nodeId, snapshotDigest: snapshot.digest, callbackPath: {
          kind: 'opening-context', reference: snapshot.reference, operationId },
        modeCeiling: { mode: 'remind', policy: { sourceId, projectId: definition.projectId, revision: 1 } } } }
  }
  const authorize = async (payload: object, operationId: T.SeatOperationId, withSender = true) => {
    const entry = h.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
      nodeId: h.options.nodeId, origin: 'remote', seat: definition.seat, taskIds: [], policyRevision: 1,
      ...(withSender ? { sourceNodeId: sender } : {}) },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
    const grant = await entry.issuer.check({ operationId, requestDigest: digest(payload) })
    if ('status' in grant) throw new Error('Expected grant')
    return { principalId, nodeId: h.options.nodeId, origin: 'remote' as const, authorization: grant }
  }
  return { h, registry, request, authorize }
}

test.each(['seat.openFrozen', 'seat.wakeFrozen'] as const)('%s admits once and queries the original result after local reload', async (method) => {
  const { h, registry, request, authorize } = await setup()
  try {
    const operationId = `frozen:${method}` as T.SeatOperationId, base = request(operationId)
    const payload = method === 'seat.openFrozen' ? base : { ...base, request: { seat: base.request.seat, operationId } }
    const invoke = async (value = payload, withSender = true) => {
      const seats = h.ctx.get('seats')!.withAuthority(await authorize(value, operationId, withSender))
      return method === 'seat.openFrozen' ? seats.openFrozen!(value as T.OpenFrozenSeatRequest) : seats.wakeFrozen!(value)
    }
    const before = h.engine.journal.projection.sequence
    expect(await invoke(payload, false)).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(h.engine.journal.projection.sequence).toBe(before)
    const first = await invoke()
    expect(first).toMatchObject(method === 'seat.openFrozen' ? { status: 'queued' } : { status: 'opened', result: { status: 'queued' } })
    expect(await invoke()).toEqual(first)
    const changed = { ...payload, openingContext: { ...payload.openingContext, openingMode: 'auto' as const } }
    expect(await invoke(changed)).toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
    const key: T.NodeWorkChainOperationKey = { sourceNodeId: sender, principalId, sourceId: payload.route.sourceId,
      ownerEpoch: payload.route.ownerEpoch, method, operationId }
    const query = { key, payloadDigest: digest(payload) }
    await expect.poll(() => ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'].map(method =>
      Boolean(registry.resolve(method as T.NodeWorkChainBusinessMethod)))).toEqual([true, true, true])
    const queryAuthority = await authorize(query, 'before-ready' as T.SeatOperationId)
    expect(await registry.query(query, queryAuthority)).toEqual({ status: 'pending', effectState: 'unknown' })
    await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
    expect(await registry.query(query, await authorize(query, 'query' as T.SeatOperationId)))
      .toEqual({ status: 'settled', method, result: first })
    await h.reload()
    await expect.poll(() => Boolean(registry.resolve('seat.openFrozen'))).toBe(true)
    await registry.ready(['seat.openFrozen', 'seat.wakeFrozen'])
    expect(await registry.query(query, await authorize(query, 'query-reload' as T.SeatOperationId)))
      .toEqual({ status: 'settled', method, result: first })
    expect(await invoke()).toEqual(first)
    expect(h.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'node-route/accepted')).toHaveLength(1)
    expect(h.adapter.requests).toHaveLength(0)
  } finally { await h.close() }
})
