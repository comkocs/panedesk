/** Real sender persistence and loopback transport surround a replaceable business owner. */
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PosixPrivateFiles, listenLoopback } from '@panedesk/dsh-host-admin'
import { ChainRouter } from '@panedesk/dsh-node-link/src/chain-router.ts'
import { ChainStore } from '@panedesk/dsh-node-link/src/chain-store.ts'
import { ChainRetainedEvidence } from '@panedesk/dsh-node-link/src/chain-retained.ts'
import { chainKey } from '@panedesk/dsh-node-link/src/chain-identity.ts'
import { decodeChainRequest } from '@panedesk/dsh-node-link/src/chain-codec.ts'
import type { ChainRequest, ChainResponse, ChainServices } from '@panedesk/dsh-node-link'
import type * as T from '@panedesk/dsh-seat'
import type { SeatEngine } from '@panedesk/dsh-seat-engine/src/engine.ts'
import { canonical } from '@panedesk/dsh-seat-engine/src/journal.ts'
import { queryRoutedCallback } from '@panedesk/dsh-seat-engine/src/routed-callback.ts'
import { seat } from '../../seat-engine/tests/fixtures.ts'
import { principalId, owner } from '../../seat-engine/tests/routed-callback-fixture.ts'
export { admittedDefinition, persistCallback } from '../../seat-engine/tests/routed-callback-fixture.ts'

export async function loopback(root: string, nodeId: T.SeatNodeId,
  receive: (request: ChainRequest) => Promise<ChainResponse>) {
  const limits = { maxFrameBytes: 200000, requestTimeoutMs: 100, maxPending: 4 }
  const authentication = { credential: randomBytes(32).toString('hex'), epoch: randomUUID() }
  const listener = await listenLoopback(0, limits, () => authentication, value => receive(decodeChainRequest(value)))
  const files = (name: string) => new PosixPrivateFiles(join(root, name), process.getuid!())
  const store = new ChainStore(files('chain-sent'), 1000000, 100)
  const evidence = new ChainRetainedEvidence(files('chain-evidence'), 1000000, 1000, nodeId, owner)
  await store.load(); await evidence.ready()
  const state = { connected: true }
  const capability = { capability: 'node-work-chain/v1' as const, maxFrameBytes: limits.maxFrameBytes,
    methods: ['source.deliverCallback', 'chain.operation'] as const }
  const router = new ChainRouter({ ...limits, directory: root, nodeId, peerNodeId: owner, peerName: 'owner',
    listenPort: 0, peerPort: listener.port, maxStoreBytes: 1000000, maxOperations: 100, staleMs: 100 }, store,
  () => ({ ...authentication, sourceNodeId: nodeId, targetNodeId: owner }), () => state.connected,
  () => ({ local: capability, remote: capability }), evidence)
  return { router, state, async close() { await router.close(); await listener.close(); await store.close(); await evidence.close() } }
}
export function response(request: ChainRequest, result: unknown): ChainResponse {
  return { version: request.version, requestId: request.requestId, sourceNodeId: request.sourceNodeId,
    targetNodeId: request.targetNodeId, operationId: request.operationId, method: request.method, status: 'ok', result } as ChainResponse
}
export function services(engine: () => SeatEngine, calls: T.SeatAuthorizationCheck[]): ChainServices {
  return { maxControlPending: 2, local: { methods: [], ready: async () => {} },
    policy: { ready: async () => {}, expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
      authorize: async () => { throw new Error('Sender does not authorize incoming calls') } },
    outboxIssuer: async (request) => {
      if (request.method !== 'source.deliverCallback') return undefined
      const retained = await queryRoutedCallback(engine(), { key: chainKey(request), payloadDigest: request.payloadDigest })
      if (!retained || canonical(retained) !== canonical(request.payload)) return undefined
      const issuer = engine().authorizationIssuers.register({ identity: { kind: 'human', principalId,
        nodeId: engine().options.nodeId, origin: 'manual', seat, taskIds: [], policyRevision: 1 },
      current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) }).issuer
      return { check: async (input) => { calls.push(input); return issuer.check(input) } }
    } }
}
