/** Connect lifecycle and event ownership through real Loader, HTTP and WebSocket composition. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { initProfile, readProfileManifest } from '@panedesk/dsh-app-boot'
import PluginManager from '@panedesk/dsh-plugin-manager'
import * as packageOperations from '../../../boot/plugin-manager/src/operations.ts'
import * as githubConnection from '../../../boot/plugin-manager/src/github-connection.ts'
import SessionStore from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import PermissionPresetService from '@panedesk/dsh-permission-presets'
import { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { materializeTlsFixture } from '../../../host/webserver/tests/tls-fixture.ts'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import * as Connection from '@panedesk/dsh-client-connection'
import LocalCredentials from '@panedesk/dsh-credentials-local'
import WebServer from '@panedesk/dsh-host-webserver'
import * as FrontendStatic from '@panedesk/dsh-host-frontend-static'
import TypertRegistry from '@panedesk/dsh-typert-registry'
import TypertGateway from '@panedesk/dsh-api-gateway'
import RemoteAccess from '@panedesk/dsh-api-remote-access'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { z } from 'zod'
import { parseRemoteStreamServerMessage, type RemoteStreamServerMessage } from '../src/stream-protocol.ts'
import { authAdmissionBody } from '@panedesk/dsh-client-connection'
import { RemoteStreamMuxServer } from '../src/stream-server.ts'
import OperatorConnectFixture from './operator-connect-fixture.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

vi.mock('@panedesk/dsh-sandbox-windows-acl', async (original) => {
  const actual = await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>()
  return { ...actual, assertWindowsStateTrusted: vi.fn() }
})

interface SocketClient {
  readonly socket: WebSocket
  readonly closed: Promise<void>
  readonly frames: RemoteStreamServerMessage[]
  readonly errors: Error[]
}
interface Host {
  readonly ctx: Context
  readonly origin: string
  readonly fixture: OperatorConnectFixture
  readonly workspace: string
  readonly ca?: string
}
const roots: string[] = []
const hosts: Host[] = []
const clients: SocketClient[] = []
const readySchema = z.object({ type: z.literal('ready'), clientId: z.string(), host: z.object({ home: z.string() }) })
const deliverySchema = z.object({
  type: z.literal('waterfall'), eventId: z.string(), request: z.object({ prompt: z.string() }),
})

afterEach(async () => {
  for (const host of hosts) {
    host.fixture.streamCleanup.resolve(undefined)
    for (const finish of host.fixture.holds.values()) finish()
  }
  await Promise.all(clients.splice(0).map(async (client) => {
    if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate()
    await client.closed
  }))
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-operator-connect-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  }
})

describe('operator connect through Loader composition', () => {
  it.each([
    ['product-sandbox', false], ['unknown', false], ['product-sandbox', true], ['unknown', true],
  ] as const)('rejects %s at all owner entries through the production adapter (TLS=%s)', async (source, tls) => {
    const host = await boot(true, true, tls)
    host.ctx.connectionSources.register(process.platform, () => source)
    const cookie = host.ctx.connection.desktopCookie(host.origin)
    const reason = source === 'product-sandbox'
      ? 'This request comes from a sandbox process and cannot act as owner. / 本请求来自沙箱进程，不能以 owner 身份执行。'
      : 'The connection source could not be verified and cannot act as owner. / 本请求的连接来源查不出，不能以 owner 身份执行。'
    const install = vi.spyOn(packageOperations, 'runProfilePnpm')
    for (const [endpoint, args] of [
      ['$events/result', { clientId: 'synthetic-client', eventId: 'synthetic-event', outcome: { kind: 'result', value: 'allowed' } }],
      ['permissionPresets/authorizeWorkspaceWrite', { workspace: host.workspace }],
      ['pluginManager/installBundle', { spec: 'synthetic-bundle' }],
    ] as const) {
      expect(await rpc(host, cookie, endpoint, args)).toEqual({ status: 403, body: reason })
    }
    expect(install).not.toHaveBeenCalled()
    expect(host.ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
    expect(host.fixture.effects.size).toBe(0)
    for (const target of [host.ctx.connection.authenticatedUrl(host.origin), `${host.origin}/connect`]) {
      const response = await transportFetch(host, target, { redirect: 'manual', headers: { cookie } })
      expect(response.status).toBe(403)
      expect(await response.text()).toBe(`${reason}\n`)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
    expect(await refusedMux(host, cookie)).toBe(403)
  })

  it.each([false, true])('admits non-product owner exchange and event delivery (TLS=%s)', async (tls) => {
    const host = await boot(true, true, tls)
    host.ctx.connectionSources.register(process.platform, () => 'non-product')
    const browser = await exchange(host, 'html')
    const api = await exchange(host, 'answer')
    const client = await mux(host, api)
    const ready = await events(client)
    const pending = host.fixture.pending('non-product-approval')
    const delivery = await invocation(client, 'non-product-approval')
    await success(host, api, '$events/result', {
      clientId: ready.clientId, eventId: delivery.eventId, outcome: { kind: 'result', value: 'allowed' },
    })
    await expect(pending).resolves.toEqual({ kind: 'result', value: 'allowed' })
    await success(host, browser, 'fixture/identity', { label: 'non-product-owner' })
    expect(call(host, 'non-product-owner').peer.principal).toEqual({ kind: 'owner' })
    await close(client)
  })

  it.each([
    ['$events/result', { clientId: 'synthetic-client', eventId: 'synthetic-event', outcome: { kind: 'result', value: 'allowed' } }],
    ['permissionPresets/authorizeWorkspaceWrite', { workspace: 'synthetic-workspace' }],
    ['pluginManager/installBundle', { spec: 'synthetic-bundle' }],
  ] as const)('rejects a forged browser cookie before dispatching %s', async (endpoint, args) => {
    const host = await boot()
    const cookie = await exchange(host, 'html')
    const separator = cookie.indexOf('=')
    const forged = `${cookie.slice(0, separator + 1)}v1.${Buffer.from(JSON.stringify({
      version: 1, authority: new URL(host.origin).host, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    })).toString('base64url')}.${Buffer.alloc(32, 1).toString('base64url')}`
    expect(await rpc(host, forged, endpoint, args)).toEqual({ status: 401, body: authAdmissionBody(401) })
    expect(host.fixture.calls.size).toBe(0)
    expect(host.fixture.effects.size).toBe(0)
    await success(host, cookie, 'fixture/identity', { label: 'legitimate-owner' })
    expect(call(host, 'legitimate-owner').peer === host.ctx.connection.browserPeer).toBe(true)
  })

  it.each([false, true])('installs a disabled bundle only for the authenticated non-product owner (TLS=%s)', async (tls) => {
    const host = await boot(false, true, tls)
    host.ctx.connectionSources.register(process.platform, () => 'non-product')
    const dir = host.ctx.profileContext.dir
    const manifestPath = join(dir, 'package.json')
    const patchPath = join(dir, 'cordis.patch.yml')
    const beforeManifest = await readFile(manifestPath, 'utf8')
    const beforePatch = await readFile(patchPath, 'utf8')
    vi.spyOn(packageOperations, 'readProfileRegistry').mockResolvedValue('https://registry.npmjs.org/')
    vi.spyOn(githubConnection, 'checkGithubConnection').mockResolvedValue(undefined)
    const install = vi.spyOn(packageOperations, 'runProfilePnpm').mockImplementation(async (_context, args) => {
      expect(args.slice(0, 2)).toEqual(['add', 'synthetic-owner-bundle'])
      const bundle = join(dir, 'node_modules', 'synthetic-owner-bundle')
      await mkdir(bundle, { recursive: true })
      await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'synthetic-owner-bundle', version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      await writeFile(join(bundle, 'cordis.patch.yml'), '[]\n')
      const manifest = readProfileManifest('fixture', dir)
      manifest.dependencies = { ...manifest.dependencies, 'synthetic-owner-bundle': '1.0.0' }
      await writeFile(manifestPath, JSON.stringify(manifest))
      return { exitCode: 0, output: 'synthetic installation', truncated: false, logPath: join(dir, 'install.log') }
    })
    const cookie = await exchange(host, 'html')
    const separator = cookie.indexOf('=')
    const forged = `${cookie.slice(0, separator + 1)}v1.${Buffer.from(JSON.stringify({
      version: 1, authority: new URL(host.origin).host, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    })).toString('base64url')}.${Buffer.alloc(32, 1).toString('base64url')}`
    const args = { spec: 'synthetic-owner-bundle', options: { enabled: false } }
    expect(await rpc(host, forged, 'pluginManager/installBundle', args)).toEqual({ status: 401, body: authAdmissionBody(401) })
    expect(install).not.toHaveBeenCalled()
    expect(await readFile(manifestPath, 'utf8')).toBe(beforeManifest)
    expect(await readFile(patchPath, 'utf8')).toBe(beforePatch)
    expect(await rpc(host, cookie, 'pluginManager/installBundle', args)).toMatchObject({ status: 200, body: {
      result: { ok: true, value: { changed: true, application: 'restart-required', stage: 'enable',
        bundle: 'synthetic-owner-bundle', packageResult: { exitCode: 0 } } },
    } })
    expect(install).toHaveBeenCalledOnce()
    expect(readProfileManifest('fixture', dir).dependencies?.['synthetic-owner-bundle']).toBe('1.0.0')
    expect((await host.ctx.pluginManager.listBundles()).find(bundle => bundle.name === 'synthetic-owner-bundle')?.enabled).toBe(false)
  })

  it.each([false, true])('records workspace authorization only for the authenticated non-product owner (TLS=%s)', async (tls) => {
    const host = await boot(true, false, tls)
    host.ctx.connectionSources.register(process.platform, () => 'non-product')
    if (process.platform !== 'win32') host.ctx.connectionSources.register('win32', () => 'non-product')
    const cookie = await exchange(host, 'html')
    const separator = cookie.indexOf('=')
    const forged = `${cookie.slice(0, separator + 1)}v1.${Buffer.from(JSON.stringify({
      version: 1, authority: new URL(host.origin).host, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    })).toString('base64url')}.${Buffer.alloc(32, 1).toString('base64url')}`
    const changes: boolean[] = []
    host.ctx.on('permission-presets/workspace-write-changed', () => {
      changes.push(host.ctx.sandboxPolicy.workspaceAccess.isAuthorized(host.workspace))
    })
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const args = { workspace: host.workspace }
    expect(await rpc(host, forged, 'permissionPresets/authorizeWorkspaceWrite', args))
      .toEqual({ status: 401, body: authAdmissionBody(401) })
    expect(host.ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
    expect(changes).toEqual([])
    await success(host, cookie, 'permissionPresets/authorizeWorkspaceWrite', args)
    expect(host.ctx.sandboxPolicy.workspaceAccess.list()).toMatchObject([
      { workspace: host.workspace, source: 'settings-preauthorization' },
    ])
    expect(changes).toEqual([true])
  })

  it('admits HTTP before attachment and releases the Operator before slow stream cleanup', async () => {
    const host = await boot()
    const cookie = await exchange(host, 'none')
    await success(host, cookie, 'fixture/identity', { label: 'before' })
    expect(call(host, 'before').peer.interactions).toBe('none')
    expect(call(host, 'before').peer === host.ctx.connection.browserPeer).toBe(false)
    const client = await mux(host, cookie)
    expect(await refusedMux(host, cookie)).toBe(409)
    await success(host, cookie, 'fixture/identity', { label: 'owner-alive' })
    host.fixture.delayStreamCleanup = true
    open(client, 'follow', 'fixture/follow', { label: 'follow' })
    await frame(client, 'follow', 'item')
    await close(client)
    await vi.waitFor(() => { expect(call(host, 'follow').signal.aborted).toBe(true) })
    expect(call(host, 'follow').finished).toBe(false)
    expect((await rpc(host, cookie, 'fixture/identity', { label: 'after' })).status).toBe(401)
    expect(await refusedMux(host, cookie)).toBe(401)
    expect(host.fixture.calls.has('after')).toBe(false)
    await vi.waitFor(() => { expect(host.fixture.effects.size).toBe(0) })
    host.fixture.streamCleanup.resolve(undefined)
    await vi.waitFor(() => { expect(call(host, 'follow').finished).toBe(true) })
  })

  it('reports failed Operator release without retaining its credential or blocking shutdown', async () => {
    const host = await boot()
    const cookie = await exchange(host, 'none')
    await success(host, cookie, 'fixture/identity', { label: 'release-failure' })
    const peer = call(host, 'release-failure').peer
    const dispose = peer.dispose.bind(peer)
    const failure = new Error('fixture Operator disposal failure')
    const disposing = vi.spyOn(peer, 'dispose').mockImplementationOnce(async () => {
      await dispose()
      throw failure
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await close(await mux(host, cookie))
      await vi.waitFor(() => {
        expect(report).toHaveBeenCalledWith('[api-gateway] Peer release failed:', failure)
      })
      expect((await rpc(host, cookie, 'fixture/identity', { label: 'refused' })).status).toBe(401)
      expect(host.fixture.calls.has('refused')).toBe(false)
      expect(host.fixture.effects.size).toBe(0)
      await host.ctx.fiber.dispose()
      expect(disposing).toHaveBeenCalledOnce()
    } finally {
      disposing.mockRestore()
      report.mockRestore()
    }
  })

  it('releases admission when the underlying socket is destroyed before upgrade', async () => {
    const host = await boot()
    const cookie = await exchange(host, 'none')
    const admit = host.ctx.connection.admitConnection.bind(host.ctx.connection)
    const admission = vi.spyOn(host.ctx.connection, 'admitConnection').mockImplementationOnce((request) => {
      const result = admit(request)
      if (!(request instanceof IncomingMessage)) throw new Error('fixture expected a Node upgrade request')
      request.socket.destroy()
      return result
    })
    const upgrade = vi.spyOn(RemoteStreamMuxServer.prototype, 'handleUpgrade')
    try {
      const client = socketClient(host, cookie)
      await client.closed
      expect(client.socket.readyState).toBe(WebSocket.CLOSED)
      expect(upgrade).not.toHaveBeenCalled()
      expect((await rpc(host, cookie, 'fixture/identity', { label: 'refused' })).status).toBe(401)
      expect(host.fixture.calls.has('refused')).toBe(false)
    } finally {
      admission.mockRestore()
      upgrade.mockRestore()
    }
  })

  it('releases admission and closes the socket when the WebSocket upgrade throws', async () => {
    const host = await boot()
    const cookie = await exchange(host, 'none')
    const failure = new Error('fixture WebSocket upgrade failure')
    const upgrade = vi.spyOn(RemoteStreamMuxServer.prototype, 'handleUpgrade').mockImplementationOnce(() => {
      throw failure
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const client = socketClient(host, cookie)
      await client.closed
      expect(client.socket.readyState).toBe(WebSocket.CLOSED)
      expect(report).toHaveBeenCalledWith('[api-gateway] Remote stream upgrade failed:', failure)
      expect((await rpc(host, cookie, 'fixture/identity', { label: 'refused' })).status).toBe(401)
      expect(host.fixture.calls.has('refused')).toBe(false)
      await close(await mux(host, await exchange(host, 'none')))
    } finally {
      upgrade.mockRestore()
      report.mockRestore()
    }
  })

  it('lets an admitted unary finish after its lifecycle socket closes', async () => {
    const host = await boot()
    const cookie = await exchange(host, 'none')
    const client = await mux(host, cookie)
    const pending = rpc(host, cookie, 'fixture/hold', { label: 'inflight' })
    await vi.waitFor(() => { expect(host.fixture.holds.has('inflight')).toBe(true) })
    await close(client)
    expect((await rpc(host, cookie, 'fixture/identity', { label: 'refused' })).status).toBe(401)
    expect(call(host, 'inflight').signal.aborted).toBe(false)
    expect(call(host, 'inflight').finished).toBe(false)
    host.fixture.holds.get('inflight')?.()
    await expect(pending).resolves.toMatchObject({ status: 200, body: { result: { ok: true, value: 'completed' } } })
    expect(call(host, 'inflight').signal.aborted).toBe(false)
  })

  it('forbids passive subscription and results, enforces stream ownership, and accepts an answering page', async () => {
    const host = await boot()
    const passiveCookie = await exchange(host, 'none')
    const passive = await mux(host, passiveCookie)
    const pageCookie = await exchange(host, 'html')
    const page = await mux(host, pageCookie)
    await success(host, pageCookie, 'fixture/identity', { label: 'browser' })
    expect(call(host, 'browser').peer === host.ctx.connection.browserPeer).toBe(true)
    const ready = await events(page)
    const otherCookie = await exchange(host, 'answer')
    const other = await mux(host, otherCookie)
    await events(other)
    open(passive, 'forbidden', '$events', {})
    expect(await frame(passive, 'forbidden', 'error')).toMatchObject({ error: { code: 'gateway/interactions-forbidden' } })
    const pending = host.fixture.pending('approval')
    const settled = vi.fn()
    void pending.then(settled)
    const delivery = await invocation(page, 'approval')
    const args = { clientId: ready.clientId, eventId: delivery.eventId, outcome: { kind: 'result', value: 'allowed' } }
    const separator = pageCookie.indexOf('=')
    const forged = `${pageCookie.slice(0, separator + 1)}v1.${Buffer.from(JSON.stringify({
      version: 1, authority: new URL(host.origin).host, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    })).toString('base64url')}.${Buffer.alloc(32, 1).toString('base64url')}`
    expect(await rpc(host, forged, '$events/result', args)).toEqual({ status: 401, body: authAdmissionBody(401) })
    expect(settled).not.toHaveBeenCalled()
    for (const cookie of [passiveCookie, otherCookie]) {
      expect(await rpc(host, cookie, '$events/result', args)).toMatchObject({
        body: { result: { ok: false, error: { code: 'gateway/interactions-forbidden' } } },
      })
    }
    await success(host, pageCookie, '$events/result', args)
    await expect(pending).resolves.toEqual({ kind: 'result', value: 'allowed' })
    expect(settled).toHaveBeenCalledOnce()
    expect(passive.frames.filter(item => item.type === 'item')).toEqual([])
  })

})

async function boot(workspaceAccess = false, pluginManagement = false, tls = false, heartbeatIntervalMs?: number): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-operator-connect-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const privateDirectory = join(root, 'private')
  await mkdir(privateDirectory, { mode: 0o700 })
  vi.stubEnv('PANEDESK_HOME', join(root, 'owner-home'))
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  const distIndex = join(root, 'index.html')
  await writeFile(distIndex, '<head></head><body>operator fixture</body>')
  const configPath = join(root, 'cordis.yml')
  const certificate = tls ? await materializeTlsFixture(join(root, 'tls')) : undefined
  const rows = [
    { name: '@panedesk/dsh-credentials-local', config: { path: join(privateDirectory, '.credentials.yaml'), watch: false } },
    { name: '@panedesk/dsh-host-webserver', config: { host: '127.0.0.1', port: 0,
      ...certificate === undefined ? {} : { tls: { certFile: certificate.certFile, keyFile: certificate.keyFile } },
    } },
    { name: '@panedesk/dsh-client-connection', config: { requireOwnerConfirmation: false } },
    { name: '@panedesk/dsh-host-frontend-static', config: { distIndex } },
    { name: '@panedesk/dsh-typert-registry' },
    { name: '@panedesk/dsh-api-remote-access' },
    { name: '@panedesk/dsh-api-gateway', ...heartbeatIntervalMs === undefined ? {} : { config: { websocketHeartbeatIntervalMs: heartbeatIntervalMs } } },
    { name: '@fixture/operator-connect' },
    ...pluginManagement ? [{ name: '@panedesk/dsh-plugin-manager' }] : [],
    { name: '@panedesk/dsh-session-projection' },
    { name: '@panedesk/dsh-sandbox-policy', config: { workspaceRoot: workspace, mode: 'read-only' } },
    { name: '@panedesk/dsh-fs-sandbox', config: { cwd: workspace } },
    ...workspaceAccess ? [
      { name: '@panedesk/dsh-session' },
      { name: '@fixture/workspace-capabilities' },
      { name: '@panedesk/dsh-permission-presets', config: { presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      } } },
    ] : [],
  ]
  await writeFile(configPath, rows.map(row => `- ${JSON.stringify({ ...row, name: `cordis:${row.name}` })}`).join('\n') + '\n')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  try {
    await ctx.plugin(Loader)
    if (pluginManagement) {
      const dir = join(root, 'profile')
      initProfile(dir, [])
      const anchor = join(root, 'package.json')
      await writeFile(anchor, JSON.stringify({ name: 'fixture-installation', dependencies: {} }))
      ctx.provide('profileContext', { name: 'fixture', dir, patchPath: join(dir, 'cordis.patch.yml'),
        installAnchor: anchor, cwd: root, home: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
    }
    Object.assign(ctx.loader.builtins, {
      include: Include,
      '@panedesk/dsh-credentials-local': LocalCredentials,
      '@panedesk/dsh-host-webserver': WebServer,
      '@panedesk/dsh-client-connection': Connection,
      '@panedesk/dsh-host-frontend-static': FrontendStatic,
      '@panedesk/dsh-typert-registry': TypertRegistry,
      '@panedesk/dsh-api-remote-access': RemoteAccess,
      '@panedesk/dsh-api-gateway': TypertGateway,
      '@fixture/operator-connect': OperatorConnectFixture,
      '@panedesk/dsh-session': SessionStore,
      '@panedesk/dsh-session-projection': SessionProjectionRegistry,
      '@panedesk/dsh-sandbox-policy': SandboxPolicyService,
      '@panedesk/dsh-fs-sandbox': SandboxedFileSystem,
      '@panedesk/dsh-permission-presets': PermissionPresetService,
      '@panedesk/dsh-plugin-manager': PluginManager,
      '@fixture/workspace-capabilities': { apply(scope: Context) {
        scope.provide('shell', { sandboxMode: 'read-only' })
        scope.provide('approval', { config: { policy: 'ask' } })
        scope.provide('sandbox', { supportsWorkspaceWriteAccess: true,
          hasWorkspaceWriteGrant: () => false, revokeWorkspaceWriteGrant: () => {} })
      } },
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect(ctx.webServer.port).toBeGreaterThan(0)
    const material = await ctx.fs.resolve(join(privateDirectory, '.credentials.yaml'))
    for (const mode of ['read-only', 'workspace-write'] as const) {
      await expect(ctx.fs.readText(material, undefined, ctx.sandboxPolicy.resolve({ mode })))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    }
    expect((await ctx.fs.readText(material, undefined, { mode: 'danger-full-access', workspaceRoot: workspace })).length)
      .toBeGreaterThan(0)
    const host: Host = { ctx, origin: `${tls ? 'https' : 'http'}://127.0.0.1:${ctx.webServer.port}`,
      fixture: ctx.operatorConnectFixture, workspace, ...certificate === undefined ? {} : { ca: certificate.ca } }
    hosts.push(host)
    return host
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function transportFetch(
  host: Host, target: string, init: { method?: string; redirect?: 'manual'; headers: Record<string, string>; body?: string },
): Promise<Response> {
  if (host.ca === undefined) return fetch(target, init)
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target, { ca: host.ca, method: init.method, headers: init.headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const entry of value) headers.append(key, entry)
          else if (value !== undefined) headers.set(key, value)
        }
        if (response.statusCode === undefined) { reject(new Error('TLS response omitted its status')); return }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }))
      })
    })
    request.on('error', reject)
    request.end(init.body)
  })
}

async function exchange(host: Host, mode: 'html' | 'none' | 'answer'): Promise<string> {
  const target = new URL(mode === 'html'
    ? host.ctx.connection.authenticatedUrl(`${host.origin}/`) : `${host.origin}/connect`)
  if (mode !== 'html') target.searchParams.set('interactions', mode)
  const ownerCookie = mode === 'html' ? undefined : await exchange(host, 'html')
  const response = await transportFetch(host, target.href, { redirect: 'manual', headers: {
    accept: mode === 'html' ? 'text/html' : 'application/json',
    ...ownerCookie === undefined ? {} : { cookie: ownerCookie },
  } })
  expect(response.status).toBe(mode === 'html' ? 303 : 302)
  const cookie = response.headers.get('set-cookie')
  await response.text()
  if (cookie === null) throw new Error('connect omitted its signed cookie')
  return cookie.split(';', 1)[0]!
}

function socketClient(host: Host, cookie: string): SocketClient {
  const socket = new WebSocket(`${host.origin.replace(/^http/, 'ws')}/api/remote.mux`, {
    headers: { cookie }, ...host.ca === undefined ? {} : { ca: host.ca },
  })
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  const frames: RemoteStreamServerMessage[] = []
  const errors: Error[] = []
  socket.on('error', error => errors.push(error))
  socket.on('message', (data) => {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8')
    frames.push(parseRemoteStreamServerMessage(text))
  })
  const client = { socket, closed, frames, errors }
  clients.push(client)
  return client
}

async function mux(host: Host, cookie: string): Promise<SocketClient> {
  const client = socketClient(host, cookie)
  await once(client.socket, 'open')
  return client
}

async function refusedMux(host: Host, cookie: string): Promise<number> {
  const client = socketClient(host, cookie)
  const status = await new Promise<number>((resolve, reject) => {
    client.socket.once('open', () => { reject(new Error('forbidden Mux was admitted')) })
    client.socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
      client.socket.terminate()
    })
    client.socket.once('error', reject)
  })
  await client.closed
  return status
}

async function close(client: SocketClient): Promise<void> {
  client.socket.close()
  await client.closed
  expect(client.errors).toEqual([])
}

function open(client: SocketClient, streamId: string, endpoint: string, args: object): void {
  client.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
}

async function frame(client: SocketClient, streamId: string, type: RemoteStreamServerMessage['type']): Promise<RemoteStreamServerMessage> {
  await vi.waitFor(() => { expect(client.frames.some(frame => frame.streamId === streamId && frame.type === type)).toBe(true) })
  return client.frames.find(frame => frame.streamId === streamId && frame.type === type)!
}

async function events(client: SocketClient): Promise<z.infer<typeof readySchema>> {
  open(client, 'events', '$events', {})
  const ready = await frame(client, 'events', 'item')
  if (ready.type !== 'item') throw new Error('event stream failed to open')
  return readySchema.parse(ready.value)
}

async function invocation(client: SocketClient, label: string): Promise<z.infer<typeof deliverySchema>> {
  let delivery: z.infer<typeof deliverySchema> | undefined
  await vi.waitFor(() => {
    for (const frame of client.frames) {
      if (frame.type !== 'item') continue
      const parsed = deliverySchema.safeParse(frame.value)
      if (parsed.success && parsed.data.request.prompt === label) delivery = parsed.data
    }
    expect(delivery).toBeDefined()
  })
  return delivery!
}

async function rpc(
  host: Host, cookie: string, endpoint: string, args: object,
): Promise<{ status: number; body: unknown }> {
  const response = await transportFetch(host, `${host.origin}/api/${endpoint}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  })
  return { status: response.status, body: response.status === 200 ? await response.json() : await response.text() }
}

async function success(host: Host, cookie: string, endpoint: string, args: object): Promise<void> {
  expect(await rpc(host, cookie, endpoint, args)).toMatchObject({ status: 200, body: { result: { ok: true } } })
}

function call(host: Host, label: string) {
  const observation = host.fixture.calls.get(label)
  if (observation === undefined) throw new Error(`fixture call was not admitted: ${label}`)
  return observation
}
