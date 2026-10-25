/** Running-host RPC composes through the Loader without a second engine. */
import { afterEach, expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { request } from 'node:http'
import * as Admin from '../src/index.ts'
import { PosixPrivateFiles } from '../src/private-files.ts'
import { callAdmin } from '../src/client.ts'
import { decodeRequest } from '../src/codec.ts'
import { callLoopback } from '../src/loopback.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 8 }

test('loads opt-in administration, authenticates five methods and disposes credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-runtime-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, admin: Admin })
  let approvals = 0
  const facts: string[] = []
  ctx.provide('hostAdminExecutor', { execute: async (request, authority) => {
    expect(authority.kind).toBe('local-operator')
    const common = { version: Admin.HOST_ADMIN_VERSION, requestId: request.requestId }
    switch (request.method) {
      case 'node.status': return { ...common, method: request.method, status: 'ok', result: {
        nodeId: 'node-a' as Admin.HostAdminEndpoint['nodeId'], nodeName: 'node-a', engine: 'running', openEngineWindows: 2, limit: 4, readyAt: null } }
      case 'engine.pending': return { ...common, method: request.method, status: 'ok', result: { items: [], watermark: 1, complete: true } }
      case 'engine.approve':
        facts.push(authority.authorizationRef)
        approvals++
        return { ...common, method: request.method, status: 'ok', result: { status: 'approved',
          queueItemId: request.params.queueItemId, stateVersion: request.params.expectedStateVersion + 1 } }
      case 'engine.cancel': return { ...common, method: request.method, status: 'ok', result: { status: 'cancelled',
        queueItemId: request.params.queueItemId, stateVersion: request.params.expectedStateVersion + 1 } }
      case 'engine.operation': return { ...common, method: request.method, status: 'ok', result: { status: 'missing' } }
      case 'engine.query': return { ...common, method: request.method, status: 'ok', result: { effects: [], complete: true, watermark: 1 } }
    }
  } })
  const directory = join(root, 'private')
  const profile = join(root, 'cordis.yml')
  await writeFile(profile, JSON.stringify([{ name: 'cordis:admin', config: { runtime: { ...limits,
    directory, nodeId: 'node-a', principalId: 'operator-a', port: 0, maxStoreBytes: 65536, maxOperations: 100 } } }]))
  const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
  await ctx.loader.await()
  const files = new PosixPrivateFiles(directory, process.getuid!())
  await expect.poll(async () => files.read('endpoint.json', 4096)).not.toBeNull()
  expect('default' in Admin).toBe(false)
  expect(await callAdmin(files, 'node.status', {}, limits)).toMatchObject({ status: 'ok', result: { openEngineWindows: 2 } })
  expect(await callAdmin(files, 'engine.pending', { limit: 10 }, limits)).toMatchObject({ status: 'ok' })
  const params = { operationId: 'operation-a', queueItemId: 'queue-a', expectedStateVersion: 1 }
  expect(await callAdmin(files, 'engine.approve', params, limits)).toMatchObject({ status: 'ok', result: { status: 'approved' } })
  expect(await callAdmin(files, 'engine.approve', params, limits)).toMatchObject({ status: 'ok' })
  expect(approvals).toBe(1); expect(facts).toHaveLength(1)
  expect(await callAdmin(files, 'engine.approve', { ...params, expectedStateVersion: 2 }, limits)).toMatchObject({ status: 'rejected' })
  expect(await callAdmin(files, 'engine.operation', { operationId: 'operation-a' }, limits)).toMatchObject({ status: 'ok' })
  expect(await callAdmin(files, 'engine.query', { limit: 10 }, limits)).toMatchObject({ status: 'ok' })
  const endpoint = JSON.parse((await files.read('endpoint.json', 4096))!) as { port: number; processEpoch: string }
  const credential = (await files.read('credential', 64))!
  const stale = decodeRequest({ version: Admin.HOST_ADMIN_VERSION, requestId: 'request-a', nonce: 'nonce-a',
    processEpoch: 'old', method: 'node.status', params: {} })
  expect(await callLoopback(endpoint.port, { credential, epoch: endpoint.processEpoch }, stale, limits)).toMatchObject({ code: 'admin-stale-epoch' })
  await ctx.loader.resolve(entry).fiber?.dispose()
  expect(await files.read('credential', 64)).toBeNull()
  expect(ctx.get('hostAdmin')).toBeUndefined()
})

test('admin runtime keeps strict Host validation for foreign hosts and other loopback ports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-host-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Admin, { runtime: { ...limits, directory: root, nodeId: 'node-a', principalId: 'operator-a',
    port: 0, maxStoreBytes: 65536, maxOperations: 100 } })
  const files = new PosixPrivateFiles(root, process.getuid!())
  await expect.poll(() => files.read('endpoint.json', 4096)).not.toBeNull()
  const endpoint = JSON.parse((await files.read('endpoint.json', 4096))!) as { port: number; processEpoch: string }
  const credential = (await files.read('credential', 64))!
  const value = { version: Admin.HOST_ADMIN_VERSION, requestId: 'request-a', nonce: 'nonce-a',
    processEpoch: endpoint.processEpoch, method: 'node.status', params: {} }
  const raw = (host: string) => new Promise<number | undefined>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: endpoint.port, method: 'POST', path: '/rpc', agent: false,
      headers: { host, 'content-type': 'application/json', authorization: credential, 'x-rpc-epoch': endpoint.processEpoch },
      signal: AbortSignal.timeout(limits.requestTimeoutMs),
    }, (response) => { response.resume(); resolve(response.statusCode) })
    req.on('error', reject); req.end(JSON.stringify(value))
  })
  expect(await raw(`browser.invalid:${endpoint.port}`)).toBe(403)
  expect(await raw(`127.0.0.1:${endpoint.port === 65535 ? 65534 : endpoint.port + 1}`)).toBe(403)
  expect(await raw(`localhost:${endpoint.port}`)).toBe(403)
  expect(await raw(`127.0.0.1:${endpoint.port}`)).toBe(200)
})

test('empty configuration registers no service and malformed methods never dispatch', async () => {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Admin, {})
  expect(ctx.get('hostAdmin')).toBeUndefined()
  expect(() => decodeRequest({ method: 'shell' })).toThrow()
})
