/** Loader composition shared by frozen ingress and complete-process recovery tests. */
import type * as T from '@panedesk/dsh-seat'
import { ChainBusinessRegistry } from '@panedesk/dsh-node-link/src/chain-business.ts'
import { admissionHost } from './admission-host.ts'
import { digest } from '../src/store.ts'

export const sender = 'sending-node' as T.SeatNodeId, principalId = 'remote-principal' as T.SeatPrincipalId
export async function frozenHost(root?: string) {
  const h = await admissionHost(root)
  const registry = new ChainBusinessRegistry()
  const registered = Promise.withResolvers<undefined>()
  const register = registry.register.bind(registry)
  registry.register = (provider) => {
    const dispose = register(provider)
    if (['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'].every(method =>
      registry.resolve(method as T.NodeWorkChainBusinessMethod))) registered.resolve(undefined)
    return dispose
  }
  h.ctx.provide('nodeWorkChainBusiness', registry)
  const definition = { ...h.definition, remoteAdmission: { allowOpen: true as const, sourceNodeIds: [sender],
    sourceIds: ['remote-source' as T.SeatSourceId], principalIds: [principalId],
    methods: ['seat.openFrozen', 'seat.wakeFrozen', 'engine.acceptFrozen'] as T.SeatRemoteOpeningMethod[], policyRevision: 1 } }
  await h.seats.save({ definition, expectedRevision: 2, operationId: 'save-remote' as T.SeatOperationId })
  await h.ctx.loader.await()
  await registered.promise
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
