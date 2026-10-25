/** Loader-backed test node; IPC controls faults while all peer traffic uses authenticated loopback. */
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import * as NodeLink from '@panedesk/dsh-node-link'
import type * as Seat from '@panedesk/dsh-seat'
import { PosixPrivateFiles, object, parseJson, digest } from '@panedesk/dsh-host-admin'
import { decodeSeatResult, decodeNodeWorkChainResult } from '@panedesk/dsh-sdk-protocol'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { networkInput, networkPrepared } from './chain-network-fixture.ts'
import { chainKey } from '../src/chain-identity.ts'
import { chainDigest, decodeChainRequest } from '../src/chain-codec.ts'
import { NodeRouter } from '../src/router.ts'
import { ChainRouter } from '../src/chain-router.ts'

const directory = process.argv[2]!
const settings = parseJson(await readFile(join(directory, 'worker.json'), 'utf8'), 65536)
if (!object(settings) || typeof settings.nodeId !== 'string' || typeof settings.peerNodeId !== 'string') throw new Error('Worker settings rejected')
const nodeId = settings.nodeId
const files = new PosixPrivateFiles(join(directory, 'business'), process.getuid!())
await files.prepare()
const saved = await files.read('records.json', 1048576)
const records: Record<string, unknown> = saved === null ? {} : JSON.parse(saved) as Record<string, unknown>
let fault = 'none', executions = Object.keys(records).length, evidenceChecks = 0, queries = 0
const held = new Set<() => void>()
const hold = () => new Promise<void>((resolve) => { held.add(resolve) })
const release = () => { for (const resolve of held) resolve(); held.clear() }
const grant = (fact: Seat.SeatIssuedAuthorizationFact) =>
  ({ fact }) as Pick<Seat.SeatAuthorizationGrant, 'fact'> as Seat.SeatAuthorizationGrant
const ctx = new Context()
ctx.baseUrl = `${pathToFileURL(directory).href}/`
await ctx.plugin(Loader)
Object.assign(ctx.loader.builtins, { include: Include, nodeLink: NodeLink })
ctx.provide('nodeLinkExecutor', { authorize: async () => false,
  execute: async () => { throw new Error('Legacy execution unavailable in chain fixture') },
  status: async () => decodeSeatResult('seats/nodeStatus', { nodeId, nodeName: nodeId,
    engine: 'running', openEngineWindows: 0, limit: 4, readyAt: null }) })
const services: NodeLink.ChainServices = { maxControlPending: 2,
  policy: { ready: async () => {}, expiry: { maxLifetimeMs: 120000, maxClockSkewMs: 0 },
    authorize: async (request, peer, evidence) => {
      evidenceChecks++
      if (fault === 'before-business') await hold()
      return { check: async () => grant({ ...evidence.fact, kind: 'node-delegation', nodeId: peer.targetNodeId,
        sourceNodeId: peer.sourceNodeId, delegatedBy: request.delegation.authorizationRef }) }
    } },
  local: { methods: ['source.prepareOpening'], ready: async () => {}, opening: {
    register: () => async () => {},
    open: async () => { throw new Error('Unexpected local opening') },
    wake: async () => { throw new Error('Unexpected local wake') },
    openBatch: async () => { throw new Error('Unexpected local batch') },
    prepare: async (request, authority) => {
      if (!authority.authorization) throw new Error('Missing admitted authority')
      const key = digest([authority.authorization.fact.sourceNodeId, authority.principalId,
        request.sourceId, request.ownerEpoch, 'source.prepareOpening', request.operationId])
      if (records[key] === undefined) {
        records[key] = { payloadDigest: authority.authorization.fact.requestDigest, result: networkPrepared(request) }
        await files.write('records.json', JSON.stringify(records)); executions++
      }
      if (fault === 'after-business') await hold()
      const record = records[key]
      if (!object(record) || record.payloadDigest !== authority.authorization.fact.requestDigest) throw new Error('Business record rejected')
      return decodeNodeWorkChainResult('source.prepareOpening', record.result)
    },
  } },
  outboxIssuer: async original => fault === 'pause-recovery' ? undefined : { check: async (request) => {
    const fresh = networkInput(original.operationId, new Date(Date.now() + 60000).toISOString())
    return grant({ ...fresh.fact, authorizationId: randomUUID(), taskIds: original.delegation.taskIds,
      operationId: request.operationId, requestDigest: request.requestDigest } as Seat.SeatIssuedAuthorizationFact)
  } },
}
if (settings.chain !== false) ctx.provide('nodeWorkChain', services)
const profile = join(directory, 'cordis.yml')
await writeFile(profile, JSON.stringify([{ name: 'cordis:nodeLink', config: { runtime: settings } }]))
await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
await ctx.loader.await()
ctx.get('nodeWorkChainBusiness')!.register({ methods: ['source.prepareOpening'], ready: async () => {}, query: async (request) => {
  queries++
  if (fault === 'during-query') await hold()
  const key = digest([request.key.sourceNodeId, request.key.principalId, request.key.sourceId,
    request.key.ownerEpoch, request.key.method, request.key.operationId])
  const record = records[key]
  if (record === undefined) return { status: 'missing' }
  if (!object(record) || record.payloadDigest !== request.payloadDigest) throw new Error('Business digest conflict')
  return { status: 'settled', method: 'source.prepareOpening', result: decodeNodeWorkChainResult('source.prepareOpening', record.result) }
} })
await new Promise<void>((resolve) => { ctx.inject(['nodeRouter'], () => { resolve() }) })
const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
reply({ ready: true, pid: process.pid })
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const command = parseJson(line, 1048576)
  if (!object(command)) throw new Error('Worker command rejected')
  if (command.kind === 'close') { fault = 'none'; release(); await ctx.fiber.dispose(); reply({ closed: true }); break }
  if (command.kind === 'fault') { fault = String(command.value); reply({ fault }); continue }
  if (command.kind === 'release') { fault = 'none'; release(); reply({ released: true }); continue }
  if (command.kind === 'status') {
    reply({ status: await ctx.get('nodeRouter')!.status(), executions, evidenceChecks, queries, held: held.size > 0 }); continue
  }
  if (command.kind === 'handshake') {
    const router = ctx.get('nodeRouter')
    if (!(router instanceof NodeRouter)) throw new Error('Node router unavailable')
    reply({ connected: await router.handshake() }); continue
  }
  if (command.kind === 'query') {
    const original = decodeChainRequest(command.request)
    const payload = { key: chainKey(original), payloadDigest: original.payloadDigest }
    const payloadDigest = chainDigest('chain.operation', payload)
    const request = decodeChainRequest({ ...original, method: 'chain.operation', payload, payloadDigest,
      requestId: randomUUID(), delegation: { ...original.delegation, authorizationRef: randomUUID(), requestDigest: payloadDigest } })
    if (request.method !== 'chain.operation') throw new Error('Query method rejected')
    const fact = command.fact as Seat.SeatIssuedAuthorizationFact
    const authorization = grant({ ...fact, authorizationId: request.delegation.authorizationRef, requestDigest: payloadDigest })
    const router = ctx.get('nodeWorkChainRouter')
    if (!(router instanceof ChainRouter)) throw new Error('Chain router unavailable')
    reply(await router.reconcile(original, request, authorization)); continue
  }
  if (command.kind === 'route') {
    const request = command.request as NodeLink.ChainRequest
    const fact = command.fact as Seat.SeatIssuedAuthorizationFact
    reply(await ctx.get('nodeWorkChainRouter')!.route(request, grant(fact))); continue
  }
  throw new Error('Unknown worker command')
}
await ctx.fiber.dispose()
await files.prepare()
