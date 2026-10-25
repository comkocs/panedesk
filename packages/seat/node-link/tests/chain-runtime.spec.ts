/** Optional Loader composition negotiates recovered owners and fetches independent durable evidence. */
import { afterEach, expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { PosixPrivateFiles, listenLoopback } from '@panedesk/dsh-host-admin'
import type * as Seat from '@panedesk/dsh-seat'
import { decodeSeatResult } from '@panedesk/dsh-sdk-protocol'
import * as NodeLink from '../src/index.ts'
import { chainDigest, decodeChainRequest } from '../src/chain-codec.ts'
import { failure } from '../src/receiver.ts'
import type { ChainRequest } from '../src/chain-types.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 2, maxStoreBytes: 65536, maxOperations: 20, staleMs: 20 }
const grant = (fact: Seat.SeatIssuedAuthorizationFact) =>
  ({ fact }) as Pick<Seat.SeatAuthorizationGrant, 'fact'> as Seat.SeatAuthorizationGrant

function prepared() {
  const deadline = new Date(Date.now() + 30000).toISOString()
  const payload = { sourceId: 'source-a', sourceOwnerNodeId: 'node-b', ownerEpoch: 'owner-a',
    reference: { providerId: 'provider-a', reference: 'opening-a', revision: '1' }, seat: 'seat-a', taskIds: ['task-a'],
    operationId: 'operation-a', targetNodeId: 'node-a', expectedSeatRevision: 1, openingMode: 'prefill' }
  const request = decodeChainRequest({ version: 'node-link/v1', requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId: 'operation-a', deadline, hop: 1, method: 'source.prepareOpening', payload,
    payloadDigest: chainDigest('source.prepareOpening', payload), delegation: { kind: 'node-delegation', hop: 1,
      principalId: 'principal-a', authorizationRef: 'grant-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
      operationId: 'operation-a', requestDigest: chainDigest('source.prepareOpening', payload), taskIds: ['task-a'], expiresAt: deadline } })
  const authorization = grant({ authorizationId: request.delegation.authorizationRef, kind: 'human',
    principalId: request.delegation.principalId, origin: 'manual', nodeId: request.sourceNodeId, taskIds: request.delegation.taskIds,
    operationId: request.operationId, policyRevision: 1, decision: 'allowed', reasonCode: 'allowed',
    requestDigest: request.payloadDigest, checkedAt: new Date().toISOString() })
  return { request, authorization }
}

test('Loader advertises only recovered capabilities, queries business truth and withdraws on provider disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chain-runtime-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const auth = () => ({ credential: randomBytes(32).toString('hex'), epoch: randomUUID() })
  const reserves = [await listenLoopback(0, limits, auth, async () => ({})), await listenLoopback(0, limits, auth, async () => ({}))]
  const ports = reserves.map(item => item.port)
  await Promise.all(reserves.map(item => item.close()))
  const credentials = [auth(), auth()], contexts: Context[] = [], withdrawals: (() => unknown)[] = []
  let release!: () => void
  const restored = new Promise<void>((resolve) => { release = resolve })
  let queries = 0
  for (const i of [0, 1]) {
    const nodeId = i === 0 ? 'node-a' : 'node-b', peerNodeId = i === 0 ? 'node-b' : 'node-a'
    const directory = join(root, nodeId), files = new PosixPrivateFiles(directory, process.getuid!())
    await files.write('inbound.json', JSON.stringify({ ...credentials[i], sourceNodeId: peerNodeId, targetNodeId: nodeId }))
    await files.write('outbound.json', JSON.stringify({ ...credentials[1 - i], sourceNodeId: nodeId, targetNodeId: peerNodeId }))
    const ctx = new Context()
    contexts.push(ctx); cleanups.push(() => ctx.fiber.dispose())
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, nodeLink: NodeLink })
    ctx.provide('nodeLinkExecutor', { authorize: async () => true, execute: async request => failure(request, 'cross-node-unsupported'),
      status: async () => decodeSeatResult('seats/nodeStatus', { nodeId, nodeName: nodeId,
        engine: 'running', openEngineWindows: 0, limit: 4, readyAt: null }) })
    ctx.provide('nodeWorkChain', { maxControlPending: 2,
      policy: { ready: async () => {}, expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
        authorize: async (request, peer, evidence) => ({ check: async () => grant({ ...evidence.fact, kind: 'node-delegation',
          nodeId: peer.targetNodeId, sourceNodeId: peer.sourceNodeId, delegatedBy: request.delegation.authorizationRef }) }) },
      local: { methods: ['source.prepareOpening'], ready: async () => {} } })
    const profile = join(root, `${nodeId}.yml`)
    await writeFile(profile, JSON.stringify([{ name: 'cordis:nodeLink', config: { runtime: {
      ...limits, directory, nodeId, peerNodeId, peerName: peerNodeId, listenPort: ports[i], peerPort: ports[1 - i],
    } } }]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
    await ctx.loader.await()
    const registry = ctx.get('nodeWorkChainBusiness')!
    const fiber = ctx.plugin({ name: `test-business-${i}`, apply(owner: Context) {
      owner.effect(() => registry.register({ methods: ['source.prepareOpening'], ready: () => restored,
        query: async () => { queries++; return { status: 'missing' } } }))
    } })
    withdrawals.push(() => fiber.dispose())
  }
  const source = contexts[0]!, target = contexts[1]!
  const f = prepared()
  expect(await source.get('nodeWorkChainRouter')!.route(f.request, f.authorization))
    .toMatchObject({ error: { cause: { reasonCode: 'peer-capability-missing' } } })
  release()
  await expect.poll(async () => (await source.get('nodeRouter')!.status())[0]?.capabilities).toContain('node-work-chain/v1')
  const payload = { key: { sourceNodeId: f.request.sourceNodeId, principalId: f.request.delegation.principalId,
    sourceId: 'source-a', ownerEpoch: 'owner-a', method: 'source.prepareOpening', operationId: f.request.operationId },
  payloadDigest: f.request.payloadDigest }
  const query = decodeChainRequest({ ...f.request, method: 'chain.operation', payload,
    payloadDigest: chainDigest('chain.operation', payload), delegation: { ...f.request.delegation,
      authorizationRef: 'query-a', requestDigest: chainDigest('chain.operation', payload) } })
  const authorization = grant({ ...f.authorization.fact,
    authorizationId: query.delegation.authorizationRef, requestDigest: query.payloadDigest })
  expect(await source.get('nodeWorkChainRouter')!.route(query, authorization)).toMatchObject({ status: 'ok', result: { status: 'missing' } })
  expect(queries).toBe(1)
  await withdrawals[1]!()
  await expect.poll(async () => (await source.get('nodeRouter')!.status())[0]?.capabilities).not.toContain('node-work-chain/v1')
  await target.fiber.dispose()
  expect(target.get('nodeWorkChainRouter')).toBeUndefined()
  const expired: ChainRequest = { ...f.request, deadline: '2000-01-01T00:00:00.000Z' }
  expect(await source.get('nodeWorkChainRouter')!.route(expired, f.authorization)).toMatchObject({ status: 'rejected' })
})
