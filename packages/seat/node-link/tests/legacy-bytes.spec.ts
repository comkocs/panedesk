/** Fixed bytes cover every legacy method through Loader transport without work-chain composition. */
import { expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { digest, PosixPrivateFiles, listenLoopback, OperationStore } from '@panedesk/dsh-host-admin'
import { decodeSeatResult, decodeMessagesResult } from '@panedesk/dsh-sdk-protocol'
import type * as Seat from '@panedesk/dsh-seat'
import type { RoutedDeliveryAuthority } from '@panedesk/dsh-message-delivery'
import * as NodeLink from '../src/index.ts'
import { decodeRequest, decodeResponse } from '../src/codec.ts'
import { NodeReceiver } from '../src/receiver.ts'
import { NodeRouter } from '../src/router.ts'
import fixtures from './fixtures/legacy-results.json' with { type: 'json' }

const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 2,
  maxStoreBytes: 1048576, maxOperations: 100, staleMs: 100 }

test.each(fixtures)('preserves $method success, refusal, digest and authorization fact bytes without nodeWorkChain', async (fixture) => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-bytes-'))
  const contexts: Context[] = []
  const credentials = [0, 1].map(() => ({ credential: randomBytes(32).toString('hex'), epoch: randomUUID() }))
  const reservations: Awaited<ReturnType<typeof listenLoopback>>[] = []
  let allowed = true
  const facts: string[] = []
  const request = decodeRequest(fixture.request)
  const fact: Seat.SeatIssuedAuthorizationFact = { ...fixture.fact, kind: 'node-delegation', origin: 'remote',
    decision: 'allowed', reasonCode: 'allowed', nodeId: request.targetNodeId,
    authorizationId: fixture.fact.authorizationId as Seat.AuthorizationRef, principalId: request.delegation.principalId,
    operationId: request.operationId, requestDigest: request.payloadDigest, delegatedBy: request.delegation.authorizationRef }
  const grant = { fact } as Pick<Seat.SeatAuthorizationGrant, 'fact'> as Seat.SeatAuthorizationGrant
  const success = () => decodeResponse({ version: request.version, requestId: request.requestId,
    sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId, operationId: request.operationId,
    method: request.method, status: 'ok', result: fixture.result }, request)
  try {
    for (const credential of credentials) reservations.push(await listenLoopback(0, limits, () => credential, async () => ({})))
    const ports = reservations.map(listener => listener.port)
    for (const listener of reservations.splice(0)) await listener.close()
    for (const i of [0, 1]) {
      const nodeId = i === 0 ? 'node-a' : 'node-b', peerNodeId = i === 0 ? 'node-b' : 'node-a'
      const directory = join(root, nodeId), files = new PosixPrivateFiles(directory, process.getuid!())
      await files.write('inbound.json', JSON.stringify({ ...credentials[i], sourceNodeId: peerNodeId, targetNodeId: nodeId }))
      await files.write('outbound.json', JSON.stringify({ ...credentials[1 - i], sourceNodeId: nodeId, targetNodeId: peerNodeId }))
      const ctx = new Context()
      contexts.push(ctx)
      ctx.baseUrl = `${pathToFileURL(root).href}/`
      await ctx.plugin(Loader)
      Object.assign(ctx.loader.builtins, { include: Include, nodeLink: NodeLink })
      const executor = NodeLink.createNodeLinkExecutor({ nodeId: request.targetNodeId,
        peer: { sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId, authenticatedAt: fact.checkedAt },
        policy: { permissions: [], expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 }, authorize: async () => ({ check: async () => {
          facts.push(JSON.stringify(fact))
          return allowed ? grant : { ...grant, fact: { ...fact, decision: 'denied' as const } }
        } }) }, authorization: {} as Seat.SeatAuthorizationTransactions,
        localSeats: { withAuthority: () => ({ operation: async () => decodeSeatResult('seats/operation', fixture.result) } as Pick<Seat.SeatService, 'operation'> as Seat.SeatService) } as Pick<Seat.SeatService, 'withAuthority'> as Seat.SeatService,
        localAdmission: { execute: async (_input, authorization) => {
          expect(JSON.stringify(authorization.fact)).toBe(fixture.factBytes)
          return success()
        } }, messages: { receive: async () => decodeMessagesResult('messages/send', fixture.result) },
        messageAuthority: { authorize: async () => ({ sourceNodeId: request.sourceNodeId,
          targetNodeId: request.targetNodeId }) as RoutedDeliveryAuthority } })
      ctx.provide('nodeLinkExecutor', { ...executor, status: async () => decodeSeatResult('seats/nodeStatus', {
        nodeId, nodeName: nodeId, engine: 'running', openEngineWindows: 0, limit: 4, readyAt: null }) })
      const profile = join(root, `${nodeId}.yml`)
      await writeFile(profile, JSON.stringify([{ name: 'cordis:nodeLink', config: { runtime: {
        ...limits, directory, nodeId, peerNodeId, peerName: peerNodeId, listenPort: ports[i], peerPort: ports[1 - i],
      } } }]))
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
      await ctx.loader.await()
      expect(ctx.get('nodeWorkChain')).toBeUndefined()
      expect(ctx.get('nodeWorkChainRouter')).toBeUndefined()
    }
    await expect.poll(() => contexts[0]!.get('nodeRouter'), { timeout: 10000 }).toBeDefined()
    const router = contexts[0]!.get('nodeRouter')!
    await expect.poll(async () => (await router.status())[0]?.reachable, { timeout: 10000 }).toBe(true)
    expect((await router.status())[0]?.capabilities).toEqual(['node-link/v1'])
    expect(digest(request.payload)).toBe(fixture.payloadDigest)
    expect(request.delegation.kind).toBe('node-delegation')
    expect(JSON.stringify(await router.route(request))).toBe(fixture.successBytes)
    if (request.method === 'messages.send') expect(facts).toEqual([])
    else {
      expect(facts.length).toBeGreaterThan(0)
      expect(facts.every(value => value === fixture.factBytes)).toBe(true)
    }
    allowed = false
    // Seat writes recheck authorization; message delivery no longer uses it.
    const direct = NodeLink.createNodeLinkExecutor({ nodeId: request.targetNodeId,
      peer: { sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId, authenticatedAt: fact.checkedAt },
      policy: { permissions: [], expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 }, authorize: async () => ({
        check: async () => ({ ...grant, fact: { ...fact, decision: 'denied' as const } }),
      }) }, authorization: {} as Seat.SeatAuthorizationTransactions, localSeats: {} as Seat.SeatService })
    const store = new OperationStore(new PosixPrivateFiles(join(root, 'refusals'), process.getuid!()), 65536, 10)
    await store.load()
    try {
      const denied = new NodeReceiver('node-b', 'node-a', store, () => direct)
      const refusalBytes = request.method === 'messages.send' ? fixture.absentBytes : fixture.refusalBytes
      expect(JSON.stringify(await denied.receive(request))).toBe(refusalBytes)
      expect(JSON.stringify(await direct.execute(request))).toBe(refusalBytes)
      const absent = new NodeReceiver('node-b', 'node-a', store, () => undefined)
      expect(JSON.stringify(await absent.receive(request))).toBe(fixture.absentBytes)
      const offline = new NodeRouter({ ...limits, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer',
        directory: root, listenPort: 0, peerPort: ports[1]! }, { ...credentials[0]!, sourceNodeId: 'node-a', targetNodeId: 'node-b' }, store, () => false)
      expect(JSON.stringify(await offline.route(request))).toBe(fixture.disconnectedBytes)
    } finally { await store.close() }
    for (const node of ['node-a', 'node-b']) {
      expect((await readdir(join(root, node))).filter(name => name.startsWith('chain-'))).toEqual([])
    }
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    for (const listener of reservations) await listener.close()
    await rm(root, { recursive: true, force: true })
  }
})
