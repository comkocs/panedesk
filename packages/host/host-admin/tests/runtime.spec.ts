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
      case 'source.operations':
      case 'source.abandon':
      case 'source.resend': return { ...common, method: request.method, status: 'unavailable',
        code: 'admin-method-unavailable', reason: 'Source operator unavailable' }
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

test('rebuilds one supervised tunnel through administration and reports a missing tunnel', async () => {
  const start = async (directory: string, rebuilds: { count: number } | undefined) => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    if (rebuilds) ctx.provide('hostAdminTransport', { rebuildTransport: async (peerNodeId) => {
      if (peerNodeId !== undefined && peerNodeId !== 'node-b') return { status: 'unavailable' }
      rebuilds.count += 1
      return { status: 'rebuilt' }
    } })
    await ctx.plugin(Admin, { runtime: { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a',
      port: 0, maxStoreBytes: 65536, maxOperations: 100 } })
    const files = new PosixPrivateFiles(directory, process.getuid!())
    await expect.poll(() => files.read('endpoint.json', 4096)).not.toBeNull()
    return files
  }
  const root = await mkdtemp(join(tmpdir(), 'admin-rebuild-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const rebuilds = { count: 0 }
  const files = await start(root, rebuilds)
  expect(await callAdmin(files, 'node.rebuild', {}, limits)).toMatchObject({ status: 'ok', result: { status: 'rebuilt' } })
  expect(rebuilds.count).toBe(1)
  expect(await callAdmin(files, 'node.rebuild', { peerNodeId: 'node-b' as Admin.HostAdminEndpoint['nodeId'] }, limits))
    .toMatchObject({ status: 'ok', result: { status: 'rebuilt' } })
  expect(await callAdmin(files, 'node.rebuild', { peerNodeId: 'other-node' as Admin.HostAdminEndpoint['nodeId'] }, limits))
    .toMatchObject({ status: 'ok', result: { status: 'unavailable' } })
  expect(rebuilds.count).toBe(2)
  const bareRoot = await mkdtemp(join(tmpdir(), 'admin-rebuild-none-'))
  cleanups.push(() => rm(bareRoot, { recursive: true, force: true }))
  const bare = await start(bareRoot, undefined)
  expect(await callAdmin(bare, 'node.rebuild', {}, limits)).toMatchObject({ status: 'ok', result: { status: 'unavailable' } })
})

test('projects a registered read detail and keeps unknown read failures generic', async () => {
  const start = async (directory: string, message: string) => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('hostAdminSourceOperator', {
      list: async () => { throw new Error(message) },
      abandon: async () => ({ status: 'ok' as const }),
    })
    await ctx.plugin(Admin, { runtime: { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a',
      port: 0, maxStoreBytes: 65536, maxOperations: 100 } })
    const files = new PosixPrivateFiles(directory, process.getuid!())
    await expect.poll(() => files.read('endpoint.json', 4096)).not.toBeNull()
    return files
  }
  const registered = await mkdtemp(join(tmpdir(), 'admin-detail-'))
  cleanups.push(() => rm(registered, { recursive: true, force: true }))
  const files = await start(registered, 'source-settlement-pending')
  expect(await callAdmin(files, 'source.operations', {}, limits)).toMatchObject({
    status: 'unavailable', code: 'admin-unavailable', detail: 'source-settlement-pending', reason: 'source-settlement-pending',
  })
  const unknown = await mkdtemp(join(tmpdir(), 'admin-detail-unknown-'))
  cleanups.push(() => rm(unknown, { recursive: true, force: true }))
  const generic = await start(unknown, 'disk failed')
  const hidden = await callAdmin(generic, 'source.operations', {}, limits)
  expect(hidden).toMatchObject({ status: 'unavailable', code: 'admin-unavailable' })
  if (hidden.status !== 'ok') expect(hidden.reason).not.toBe('disk failed')
})

test('retries one no-effect source refusal and does not replay a lost source write', async () => {
  expect(Admin.hostAdminDetailCode(new Error('source-settlement-pending'))).toBe('source-settlement-pending')
  expect(Admin.hostAdminDetailCode(new Error('write-budget-exceeded-before-write'))).toBe('write-budget-exceeded-before-write')
  expect(Admin.hostAdminDetailCode(new Error('disk failed'))).toBeUndefined()
  const open = async (directory: string, execute: Admin.HostAdminExecutor['execute']) => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('hostAdminSourceOperator', { list: async () => ({ items: [] }), abandon: async () => ({ status: 'ok' as const }) })
    ctx.provide('hostAdminExecutor', { execute })
    await ctx.plugin(Admin, { runtime: { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a',
      port: 0, maxStoreBytes: 65536, maxOperations: 100 } })
    const files = new PosixPrivateFiles(directory, process.getuid!())
    await expect.poll(() => files.read('endpoint.json', 4096)).not.toBeNull()
    return files
  }
  const retryRoot = await mkdtemp(join(tmpdir(), 'admin-retry-'))
  cleanups.push(() => rm(retryRoot, { recursive: true, force: true }))
  let retries = 0
  const retryFiles = await open(retryRoot, async (request) => {
    if (request.method !== 'source.abandon') return { version: Admin.HOST_ADMIN_VERSION, requestId: request.requestId,
      method: request.method, status: 'unavailable', code: 'admin-method-unavailable', reason: 'unused' }
    retries += 1
    const result = retries === 1
      ? { status: 'rejected' as const, code: 'write-budget-exceeded-before-write', reason: 'write-budget-exceeded-before-write', effect: 'none' as const }
      : { status: 'ok' as const }
    return { version: Admin.HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method, status: 'ok' as const, result }
  })
  const write = { operationId: 'source-a', key: 'key-a', reason: 'Reviewed' }
  expect(await callAdmin(retryFiles, 'source.abandon', write, limits)).toMatchObject({ status: 'ok', result: { status: 'rejected', effect: 'none' } })
  expect(await callAdmin(retryFiles, 'source.abandon', write, limits)).toMatchObject({ status: 'ok', result: { status: 'ok' } })
  expect(retries).toBe(2)
  const lostRoot = await mkdtemp(join(tmpdir(), 'admin-lost-'))
  cleanups.push(() => rm(lostRoot, { recursive: true, force: true }))
  let lost = 0
  const lostFiles = await open(lostRoot, async (request) => {
    if (request.method !== 'source.abandon') return { version: Admin.HOST_ADMIN_VERSION, requestId: request.requestId,
      method: request.method, status: 'unavailable', code: 'admin-method-unavailable', reason: 'unused' }
    lost += 1
    throw new Error('lost')
  })
  const again = { operationId: 'source-b', key: 'key-b', reason: 'Reviewed' }
  expect(await callAdmin(lostFiles, 'source.abandon', again, limits)).toMatchObject({ status: 'uncertain', code: 'admin-outcome-unknown' })
  expect(await callAdmin(lostFiles, 'source.abandon', again, limits)).toMatchObject({ status: 'uncertain', code: 'admin-outcome-unknown' })
  expect(lost).toBe(1)
})
