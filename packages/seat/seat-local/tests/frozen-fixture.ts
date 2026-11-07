/** Loader composition shared by frozen ingress and complete-process recovery tests. */
import type * as T from '@panedesk/dsh-seat'
import { ChainBusinessRegistry } from '@panedesk/dsh-node-link/src/chain-business.ts'
import { admissionHost } from './admission-host.ts'
import { digest } from '../src/store.ts'

export const sender = 'sending-node' as T.SeatNodeId, principalId = 'remote-principal' as T.SeatPrincipalId
export async function frozenHost(root?: string, engineConfig: Partial<T.SeatEngineConfig> = {}) {
  const h = await admissionHost(root, engineConfig)
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
  const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'] as const
  h.ctx.provide('nodeWorkChain', { maxControlPending: 2,
    local: { methods, seats: h.ctx.get('seats')!, engine: h.engine, ready: () => registry.ready(methods) },
    policy: { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 1000 }, ready: () => Promise.resolve(),
      authorize: async () => { throw new Error('Fixture uses independently captured receiver grants') } } })
  const definition = { ...h.definition, remoteAdmission: { allowOpen: true as const, sourceNodeIds: [sender],
    sourceIds: ['remote-source' as T.SeatSourceId], principalIds: [principalId],
    methods: ['seat.openFrozen', 'seat.wakeFrozen', 'engine.acceptFrozen'] as T.SeatRemoteOpeningMethod[], policyRevision: 1 } }
  if ((await h.seats.definitions({})).revision === 2) {
    await h.seats.save({ definition, expectedRevision: 2, operationId: 'save-remote' as T.SeatOperationId })
  }
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
  const authorize = async (_payload: object, _operationId: T.SeatOperationId) => ({
    principalId, nodeId: h.options.nodeId, origin: 'remote' as const,
  })
  return { h, registry, request, authorize }
}
