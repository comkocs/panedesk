/** Two Loader peers use real local admission and the engine authorization journal. */
import { expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import * as Link from '@panedesk/dsh-node-link'
import { decodeRequest } from '@panedesk/dsh-node-link/src/codec.ts'
import { PosixPrivateFiles, listenLoopback, digest } from '@panedesk/dsh-host-admin'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'

const limits = { maxFrameBytes: 1048576, requestTimeoutMs: 10000, maxPending: 8,
  maxStoreBytes: 1048576, maxOperations: 100, staleMs: 20 }
test('routes six methods through Loader peers with real admission or explicit unsupported refusal', async () => {
  const target = await admissionHost(), source = new Context()
  const registrations: (() => void)[] = []
  const held: Awaited<ReturnType<typeof listenLoopback>>[] = []
  try {
    await source.plugin(Loader)
    source.baseUrl = `${pathToFileURL(target.options.directory).href}/`
    Object.assign(source.loader.builtins, { include: Include, link: Link })
    Object.assign(target.ctx.loader.builtins, { link: Link })
    const credentials = [0, 1].map(() => ({ credential: randomBytes(32).toString('hex'), epoch: randomUUID() }))
    for (const auth of credentials) held.push(await listenLoopback(0, limits, () => auth, async () => ({})))
    const ports = held.map(listener => listener.port)
    for (const listener of held) await listener.close()
    held.length = 0
    const nodes = ['node-b', 'node-a'], contexts = [source, target.ctx]
    const evidence = new Map<T.AuthorizationRef, Link.DelegationEvidence>()
    const expiry = { maxLifetimeMs: 60000, maxClockSkewMs: 1000 }
    const methods = ['seat.open', 'seat.openBatch', 'seat.renew', 'seat.close', 'seat.replace', 'seat.wake'] as const
    const policy = Link.createDelegationReceivingPolicy({ expiry,
      permissions: [{ sourceNodeId: 'node-b' as T.SeatNodeId, targetNodeId: target.options.nodeId, methods, policyRevision: 1 }],
      evidence: async reference => evidence.get(reference) ?? null,
      issuer: async (retained) => {
        const registration = target.engine.authorizationIssuers.register({ identity: {
          kind: 'node-delegation', principalId: retained.original.principalId, origin: retained.original.origin,
          nodeId: target.options.nodeId, seat: target.definition.seat, taskIds: [], policyRevision: 1,
          delegatedBy: retained.delegation.authorizationRef },
        current: () => evidence.has(retained.delegation.authorizationRef)
          ? { decision: 'allowed', reasonCode: 'verified-peer-evidence', policyRevision: 1 } : null })
        registrations.push(() => { registration.dispose() })
        return registration.issuer
      } })
    target.ctx.provide('nodeDelegationReceivingPolicy', policy)
    source.provide('nodeLinkExecutor', { authorize: async () => false,
      execute: async () => { throw new Error('Source execution is disabled') },
      status: async () => ({ nodeId: 'node-b' as T.SeatNodeId, nodeName: 'source', engine: 'running',
        openEngineWindows: 0, limit: null, readyAt: null }) })
    for (const i of [0, 1]) {
      const directory = join(target.options.directory, `link-${i}`)
      const files = new PosixPrivateFiles(directory, process.getuid!())
      await files.write('inbound.json', JSON.stringify({ ...credentials[i], sourceNodeId: nodes[1 - i], targetNodeId: nodes[i] }))
      await files.write('outbound.json', JSON.stringify({ ...credentials[1 - i], sourceNodeId: nodes[i], targetNodeId: nodes[1 - i] }))
      const path = join(target.options.directory, `link-${i}.yml`)
      await writeFile(path, JSON.stringify([{ name: 'cordis:link', config: { runtime: { ...limits, directory,
        nodeId: nodes[i], peerNodeId: nodes[1 - i], peerName: nodes[1 - i], listenPort: ports[i], peerPort: ports[1 - i] } } }]))
      await contexts[i]!.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
      await contexts[i]!.loader.await()
    }
    await expect.poll(async () => (await source.get('nodeRouter')?.status())?.[0]?.reachable).toBe(true)
    const router = source.get('nodeRouter')!
    const route = async (method: typeof methods[number], payload: object) => {
      const deadline = new Date(Date.now() + 50000).toISOString(), operationId = `remote-${method}`
      const body = { ...payload, nodeId: 'node-a', operationId }, requestDigest = digest(body)
      const authorizationRef = randomUUID() as T.AuthorizationRef
      const request = decodeRequest({ version: Link.NODE_LINK_VERSION, requestId: randomUUID(),
        sourceNodeId: 'node-b', targetNodeId: 'node-a', operationId, deadline, hop: 1, method, payload: body,
        payloadDigest: requestDigest, delegation: { kind: 'node-delegation', hop: 1,
          principalId: 'trusted-source', authorizationRef, sourceNodeId: 'node-b', targetNodeId: 'node-a',
          operationId, requestDigest, seat: target.definition.seat, taskIds: [], expiresAt: deadline } })
      const { delegation, ...prepared } = request
      evidence.set(authorizationRef, { request: prepared, delegation,
        original: { kind: 'human', principalId: delegation.principalId, nodeId: 'node-b' as T.SeatNodeId,
          authorizationId: authorizationRef, origin: 'manual', operationId: request.operationId,
          requestDigest: request.payloadDigest, seat: target.definition.seat, taskIds: [], policyRevision: 1,
          decision: 'allowed', reasonCode: 'authenticated-source', checkedAt: new Date().toISOString() } })
      return router.route(request)
    }
    const opened = await route('seat.open', { seat: target.definition.seat, origin: 'manual', openingMode: 'prefill' })
    expect(opened, JSON.stringify(opened)).toMatchObject({ status: 'ok', method: 'seat.open', result: { status: 'prefilled' } })
    if (opened.status !== 'ok' || opened.method !== 'seat.open' || opened.result.status !== 'prefilled') throw new Error('Expected remote window')
    const sessionId = opened.result.sessionId
    expect(await route('seat.openBatch', { seats: [target.definition.seat], origin: 'manual' }))
      .toMatchObject({ status: 'rejected', error: { code: 'cross-node-unsupported' } })
    expect(await route('seat.wake', { seat: target.definition.seat, sessionId }))
      .toMatchObject({ status: 'rejected', error: { code: 'cross-node-unsupported' } })
    expect(await route('seat.renew', { sessionId })).toMatchObject({ status: 'ok', result: { status: 'rejected' } })
    expect(await route('seat.replace', { sessionId })).toMatchObject({ status: 'ok', result: { status: 'queued' } })
    expect(await route('seat.close', { sessionId, expectedStateVersion: 999 })).toMatchObject({ status: 'ok', result: { status: 'conflict' } })
    const page = await target.engine.authorizations.query({ kind: 'node-delegation', limit: 20 })
    if ('status' in page) throw new Error('Expected persisted attribution')
    expect(page.facts.map(fact => fact.operationId)).toEqual(['remote-seat.open', 'remote-seat.replace'])
    const frames = target.engine.journal.projection.authorizationDecisions.filter(frame => frame.effects.some(effect => effect.kind === 'authorization/checked'))
    expect(frames.map(frame => frame.effects.map(effect => effect.kind))).toEqual([
      ['trigger/accepted', 'authorization/checked'], ['window/replacement', 'queue/pending', 'authorization/checked']])
    await target.reload()
    const after = await target.engine.authorizations.query({ kind: 'node-delegation', limit: 20 })
    expect(after).toMatchObject({ facts: page.facts })
  } finally {
    for (const dispose of registrations) dispose()
    for (const listener of held) await listener.close()
    await source.fiber.dispose(); await target.close()
  }
})
