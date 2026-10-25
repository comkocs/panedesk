/** Test composition retains original entry identity and signs each exact wire request independently. */
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PosixPrivateFiles, listenLoopback } from '@panedesk/dsh-host-admin'
import { ChainRouter } from '@panedesk/dsh-node-link/src/chain-router.ts'
import { ChainStore } from '@panedesk/dsh-node-link/src/chain-store.ts'
import { ChainRetainedEvidence } from '@panedesk/dsh-node-link/src/chain-retained.ts'
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { SourceProxyInputs, SourceProxyPort, SourceProxySend, SourceProxyOutcome,
  SourceProxyRecord, SeatEngine } from '@panedesk/dsh-seat-engine'
import { digest } from '@panedesk/dsh-seat-engine'
import { chainDigest, decodeChainRequest, decodeChainResponse } from '@panedesk/dsh-node-link/src/chain-codec.ts'
import type { ChainCapability } from '@panedesk/dsh-node-link'
import { defineDomain, domainTable, type DomainFacility } from '@panedesk/dsh-storage-domain'
import { z } from 'zod'

const spec = defineDomain({ name: 'source_proxy_test_outbox', version: 1, layout: 'per-record',
  tables: { intents: domainTable(z.object({ request: z.string(), identity: z.string() })) } })
export const remoteNode = 'remote-node' as T.SeatNodeId
export const proxyPrincipal = 'source-principal' as T.SeatPrincipalId
export const proxySource = 'proxy-source' as T.SeatSourceId
export function prepared<M extends T.SeatRemoteOpeningMethod>(method: M, input: SourceProxyInputs[M], nodeId: T.SeatNodeId,
  operationId: T.SeatOperationId): T.NodeWorkChainMethodMap[M]['request'] {
  const snapshot: T.OpeningContextSnapshot = { reference: { providerId: 'source-provider' as T.OpeningProviderId,
    reference: 'source-reference' as T.OpeningContextReference['reference'], revision: '1' }, text: 'Frozen source text',
  digest: digest('Frozen source text'), revision: '1', taskIds: [], scopeEvidence: [] }
  const ownerEpoch = 'source-epoch' as T.OwnerEpoch
  const route: T.NodeWorkChainRoute = { sourceId: proxySource, sourceOwnerNodeId: nodeId, ownerEpoch,
    triggerId: 'triggerId' in input ? input.triggerId : null, originalOperationId: operationId, targetNodeId: remoteNode,
    snapshotDigest: snapshot.digest, callbackPath: { kind: 'source', sourceId: proxySource },
    modeCeiling: { mode: 'remind', policy: { sourceId: proxySource, projectId: 'project-a' as T.SeatProjectId, revision: 1 } } }
  const common = { route, expectedSeatRevision: 1, openingContext: { snapshot, openingMode: 'auto' as const,
    scopeReservation: { reservationId: 'source-reservation' as T.NodeWorkChainScopeReservation['reservationId'],
      sourceId: proxySource, sourceOwnerNodeId: nodeId, ownerEpoch, operationId, taskIds: [],
      snapshotDigest: snapshot.digest, policyRevision: 1 } } }
  if (method === 'engine.acceptFrozen') return { ...common, envelope: input } as T.NodeWorkChainMethodMap[M]['request']
  const { openingContext: _reference, relatedTaskIds: _tasks, ...request } = input as T.OpenSeatWithContextRequest
  return { ...common, request }
}
export async function composition(engine: SeatEngine, facility: DomainFacility, ctx: Context) {
  const domain = await facility.open(spec), intents = domain.table('intents')
  const grants: T.SeatAuthorizationGrant[] = [], originals: T.SeatAuthorizationGrant[] = []
  const entry = engine.authorizationIssuers.register({ identity: { kind: 'human', origin: 'manual', principalId: proxyPrincipal,
    nodeId: engine.options.nodeId, seat: 'seat-a' as T.SeatName, taskIds: [], policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'local-entry', policyRevision: 1 }) })
  const state = { sends: 0, prepares: 0, unknown: false, reject: false }
  const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 2,
    maxStoreBytes: 1048576, maxOperations: 100, staleMs: 20 }
  const credential = { credential: randomBytes(32).toString('hex'), epoch: randomUUID() }
  const receipts = new Map<string, T.NodeWorkChainMethodMap[T.SeatRemoteOpeningMethod]['result']>()
  const listener = await listenLoopback(0, limits, () => credential, async (value) => {
    const request = decodeChainRequest(value)
    if (request.method === 'chain.operation') {
      const result = receipts.get(request.operationId)
      return decodeChainResponse({ ...request, status: 'ok', result: result
        ? { status: 'settled', method: request.payload.key.method, result } : { status: 'missing' } }, request)
    }
    const queued: T.SeatQueued = { status: 'queued', queueItemId: 'remote-queue' as T.QueueItemId,
      sequence: 1, reason: 'approval', blockedBy: [] }
    const result = state.reject ? { status: 'rejected', error: { code: 'gate-denied', message: 'Remote policy denied',
      alternative: 'Review remote policy', retryable: false, effectState: 'none' } }
      : request.method === 'engine.acceptFrozen' ? { status: 'accepted', triggerId: request.payload.route.triggerId,
        queueItemId: queued.queueItemId, sequence: 1 }
        : request.method === 'seat.wakeFrozen' ? { status: 'opened', result: queued } : queued
    const response = decodeChainResponse({ ...request, status: 'ok', result }, request)
    if (response.status === 'ok' && (response.method === 'engine.acceptFrozen'
      || response.method === 'seat.openFrozen' || response.method === 'seat.wakeFrozen')) {
      receipts.set(request.operationId, response.result)
    }
    return response
  })
  const files = new PosixPrivateFiles(join(engine.journal.root, 'source-proxy-test-wire'), process.getuid!())
  const store = new ChainStore(files, limits.maxStoreBytes, limits.maxOperations)
  const evidence = new ChainRetainedEvidence(files, limits.maxStoreBytes, limits.maxOperations, engine.options.nodeId, remoteNode)
  await store.load(); await evidence.ready()
  const capability: ChainCapability = { capability: 'node-work-chain/v1', maxFrameBytes: limits.maxFrameBytes,
    methods: ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen', 'chain.operation'] }
  const router = new ChainRouter({ ...limits, nodeId: engine.options.nodeId, peerNodeId: remoteNode, peerName: remoteNode,
    directory: engine.journal.root, listenPort: 0, peerPort: listener.port }, store, () => ({ ...credential,
    sourceNodeId: engine.options.nodeId, targetNodeId: remoteNode }), () => true,
  () => ({ local: capability, remote: capability }), evidence)
  const withdraw = ctx.provide('nodeWorkChainRouter', router)
  async function send<M extends T.SeatRemoteOpeningMethod>(input: SourceProxySend<M>): Promise<SourceProxyOutcome<M>> {
    state.sends++
    originals.push(input.original)
    const record = engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .find(effect => effect.kind === 'node-source/updated' && effect.operationId === input.operationId)
    if (record?.kind !== 'node-source/updated' || record.data.outcome.status !== 'unknown') throw new Error('Missing durable reservation')
    const { authorizationId: _id, operationId: _operation, requestDigest: _digest, checkedAt: _time,
      decision: _decision, reasonCode: _reason, ...identity } = input.original.fact
    await intents.put(digest(record.data.operationKey), { request: JSON.stringify(input.payload), identity: JSON.stringify(identity) })
    const retained = intents.get(digest(record.data.operationKey))
    const registration = engine.authorizationIssuers.register({ identity,
      current: () => retained?.request === JSON.stringify(input.payload)
        ? { decision: 'allowed', reasonCode: 'retained-intent', policyRevision: identity.policyRevision } : null })
    try {
      const grant = await registration.issuer.check({ operationId: input.operationId,
        requestDigest: chainDigest(input.method, input.payload) })
      if ('status' in grant) throw new Error('Missing wire grant')
      const fact = grant.fact, expiresAt = new Date(Date.now() + 60000).toISOString()
      const request = decodeChainRequest({ version: 'node-link/v1', requestId: randomUUID(), sourceNodeId: engine.options.nodeId,
        targetNodeId: input.targetNodeId, operationId: input.operationId, method: input.method, payload: input.payload,
        payloadDigest: fact.requestDigest, deadline: expiresAt, hop: 1,
        delegation: { authorizationRef: fact.authorizationId, principalId: fact.principalId, sourceNodeId: engine.options.nodeId,
          targetNodeId: input.targetNodeId, operationId: fact.operationId, requestDigest: fact.requestDigest,
          seat: fact.seat, taskIds: fact.taskIds, expiresAt, hop: 1, kind: 'node-delegation' } })
      grants.push(grant)
      const response = await ctx.get('nodeWorkChainRouter')!.route(request, grant)
      if (state.unknown || response.status !== 'ok') return { status: 'unknown' }
      if (response.method !== 'engine.acceptFrozen' && response.method !== 'seat.openFrozen'
        && response.method !== 'seat.wakeFrozen') throw new Error('Unexpected response method')
      if (response.result.status === 'rejected') return { status: 'rejected', result: response.result }
      return { status: 'committed', result: response.result }
    } finally { registration.dispose() }
  }
  async function reconcile(record: SourceProxyRecord): Promise<SourceProxyOutcome<T.SeatRemoteOpeningMethod>> {
    const retained = intents.get(digest(record.operationKey))
    const { authorizationId: _id, operationId: _operation, requestDigest: _digest, checkedAt: _time,
      decision: _decision, reasonCode: _reason, ...identity } = record.original
    if (retained?.request !== JSON.stringify(record.payload) || retained.identity !== JSON.stringify(identity)) return { status: 'unknown' }
    const payload = { key: record.operationKey, payloadDigest: chainDigest(record.method, record.payload) }
    const registration = engine.authorizationIssuers.register({ identity,
      current: () => intents.get(digest(record.operationKey))?.request === JSON.stringify(record.payload)
        ? { decision: 'allowed', reasonCode: 'retained-query', policyRevision: identity.policyRevision } : null })
    try {
      const grant = await registration.issuer.check({ operationId: record.operationKey.operationId,
        requestDigest: chainDigest('chain.operation', payload) })
      if ('status' in grant) return { status: 'unknown' }
      const fact = grant.fact, expiresAt = new Date(Date.now() + 60000).toISOString()
      const request = decodeChainRequest({ version: 'node-link/v1', requestId: randomUUID(), sourceNodeId: engine.options.nodeId,
        targetNodeId: record.targetNodeId, operationId: record.operationKey.operationId, method: 'chain.operation', payload,
        payloadDigest: fact.requestDigest, deadline: expiresAt, hop: 1,
        delegation: { authorizationRef: fact.authorizationId, principalId: fact.principalId, sourceNodeId: engine.options.nodeId,
          targetNodeId: record.targetNodeId, operationId: fact.operationId, requestDigest: fact.requestDigest,
          seat: fact.seat, taskIds: fact.taskIds, expiresAt, hop: 1, kind: 'node-delegation' } })
      grants.push(grant)
      const response = await ctx.get('nodeWorkChainRouter')!.route(request, grant)
      if (response.status !== 'ok' || response.method !== 'chain.operation' || response.result.status !== 'settled'
        || response.result.method !== record.method) return { status: 'unknown' }
      const result = response.result.result
      return result.status === 'rejected' ? { status: 'rejected', result } : { status: 'committed', result }
    } finally { registration.dispose() }
  }
  const port: SourceProxyPort = { target: async () => remoteNode, send,
    prepare: async ({ method, input, authority }) => {
      state.prepares++
      const operationId = 'operationId' in input ? input.operationId : 'trigger-operation' as T.SeatOperationId
      const original = authority?.authorization ?? await entry.issuer.check({ operationId, requestDigest: digest(input) })
      if ('status' in original) return original
      return { payload: prepared(method, input, engine.options.nodeId, operationId), original }
    } }
  const grant = async (input: T.OpenSeatWithContextRequest | T.WakeSeatWithContextRequest) => {
    const authorization = await entry.issuer.check({ operationId: input.operationId, requestDigest: digest(input) })
    if ('status' in authorization) throw new Error('Missing local grant')
    return { nodeId: engine.options.nodeId, principalId: proxyPrincipal, origin: 'manual' as const, authorization }
  }
  return { port, grant, reconcile, state, grants, originals, intents,
    close: async () => {
      withdraw(); await router.close(); await listener.close(); await store.close(); await evidence.close()
      entry.dispose(); await domain.close()
    } }
}
