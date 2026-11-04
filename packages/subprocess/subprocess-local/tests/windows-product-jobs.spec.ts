import { Context } from '@panedesk/cordis'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowsProductJobs } from '../src/windows-product-jobs.ts'
import LocalSubprocessRuntime from '../src/index.ts'
import { ConnectionSourceRegistry, OwnerConnectionSource } from '@panedesk/dsh-client-connection/src/connection-source.ts'
import { BrowserAuth } from '@panedesk/dsh-client-connection/src/browser-auth.ts'
import { HostConnectionService } from '@panedesk/dsh-client-connection/src/rpc-host.ts'
import { CredentialProvider } from '@panedesk/dsh-credentials'
import type { CredentialRecord } from '@panedesk/dsh-credentials'
import type { TcpOwnerBindings, TcpConnectionEndpoints, NativePtr } from '@panedesk/dsh-win32-process'

class MemoryCredentials extends CredentialProvider {
  private record: CredentialRecord | undefined
  resolve(): Promise<never> { throw new Error('unused reference operation') }
  describe(): Promise<never> { throw new Error('unused reference operation') }
  set(): Promise<never> { throw new Error('unused reference operation') }
  unset(): Promise<never> { throw new Error('unused reference operation') }
  describeRecord(): Promise<never> { throw new Error('unused record metadata') }
  listRecords(): Promise<never> { throw new Error('unused record listing') }
  readRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(this.record) }
  async modifyRecord(
    _key: unknown,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.record = await mutate(this.record) ?? this.record
    return this.record
  }
  deleteRecord(): Promise<void> { this.record = undefined; return Promise.resolve() }
}

const native = vi.hoisted(() => ({
  create: vi.fn(), lookup: vi.fn<typeof import('@panedesk/dsh-win32-process').lookupTcpOwner>(),
  close: vi.fn(), launch: vi.fn(), terminal: vi.fn(),
}))
vi.mock('../src/windows-job.ts', () => ({ probeWindowsJob: () => true, launchWindowsJob: native.launch }))
vi.mock('@panedesk/dsh-lazy-require', () => ({
  createLazyRequire: (specifier: string) => () => {
    if (specifier === 'node-pty') return { spawn: native.terminal }
    throw new Error('unexpected native dependency')
  },
}))
vi.mock('@panedesk/dsh-win32-process', async original => ({
  ...await original<typeof import('@panedesk/dsh-win32-process')>(),
  createProductJob: native.create,
  loadTcpOwnerBindings: () => ({}),
  lookupTcpOwner: (...args: Parameters<typeof import('@panedesk/dsh-win32-process').lookupTcpOwner>) => native.lookup(...args),
}))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

function prepare() {
  native.create.mockReturnValue({ name: 'fixture-job', handle: 9n, close: native.close })
  native.lookup.mockReturnValue('product-sandbox')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const ctx = new Context()
  const registry = new ConnectionSourceRegistry(ctx)
  return { ctx, registry }
}

describe('Windows product source registration', () => {
  it('uses TCP ownership and inherited Job facts for cookie admission, including descendants and IPv6', async () => {
    const { ctx, registry } = prepare()
    const actual = await vi.importActual<typeof import('@panedesk/dsh-win32-process')>('@panedesk/dsh-win32-process')
    const members = new Map<number, Set<NativePtr>>()
    const inherit = (parent: number, child: number): void => { members.set(child, new Set(members.get(parent))) }
    members.set(10, new Set([9n as NativePtr]))
    inherit(10, 11)
    inherit(10, 12)
    inherit(12, 13)
    inherit(13, 14)
    let pid = 11
    let ipv6 = false
    let absent = false
    let inaccessible = false
    const api: TcpOwnerBindings = {
      getExtendedTcpTable(buffer, size, _order, family) {
        const present = !absent && family === (ipv6 ? 23 : 2)
        size.writeUInt32LE(present ? (ipv6 ? 60 : 28) : 4)
        if (buffer === null) return 122
        buffer.writeUInt32LE(Number(present))
        if (!present) return 0
        if (ipv6) {
          buffer[19] = 1
          buffer.writeUInt16BE(42000, 24)
          buffer[43] = 1
          buffer.writeUInt16BE(8080, 48)
          buffer.writeUInt32LE(5, 52)
          buffer.writeUInt32LE(pid, 56)
        } else {
          buffer.writeUInt32LE(5, 4)
          buffer.set([127, 0, 0, 1], 8)
          buffer.writeUInt16BE(42000, 12)
          buffer.set([127, 0, 0, 1], 16)
          buffer.writeUInt16BE(8080, 20)
          buffer.writeUInt32LE(pid, 24)
        }
        return 0
      },
      openProcess: (_access, _inherit, owner) => inaccessible ? null : BigInt(owner) as NativePtr,
      isProcessInJob(process, job, output) { output.writeUInt32LE(Number(members.get(Number(process))?.has(job) ?? false)); return 1 },
      closeHandle: () => 1,
    }
    native.lookup.mockImplementation((
      _api: TcpOwnerBindings, jobs: NativePtr | readonly NativePtr[], socket: TcpConnectionEndpoints | undefined,
    ) => actual.lookupTcpOwner(api, jobs, socket))
    try {
      const fiber = ctx.plugin(LocalSubprocessRuntime)
      await fiber.await()
      WindowsProductJobs.forHost(ctx).prepare({})
      const auth = await BrowserAuth.create(ctx, new MemoryCredentials(ctx), 30, () => true,
        new OwnerConnectionSource(socket => registry.classify(socket)))
      const connection = new HostConnectionService(ctx, [], auth)
      try {
        const cookie = auth.desktopCookie('http://localhost')
        const request = () => ({
          headers: { host: 'localhost', cookie },
          socket: Object.assign(new EventEmitter(), {
            remoteAddress: ipv6 ? '::1' : '127.0.0.1', localAddress: ipv6 ? '::1' : '127.0.0.1',
            remotePort: 42000, localPort: 8080,
          }),
        })
        const refused = { rejection: 403, reason: 'This request comes from a sandbox process and cannot act as owner. / 本请求来自沙箱进程，不能以 owner 身份执行。' }
        for (const member of [11, 12, 14]) {
          pid = member
          const same = request()
          const before = native.lookup.mock.calls.length
          expect(connection.admit(same)).toEqual(refused)
          expect(connection.admit(same)).toEqual(refused)
          expect(native.lookup.mock.calls.length - before).toBe(1)
        }
        ipv6 = true
        expect(connection.admit(request())).toEqual(refused)
        for (const external of [21, 22, 23]) {
          pid = external
          expect(connection.admit(request())).toEqual({ peer: connection.browserPeer })
        }
        const unknown = { rejection: 403, reason: 'The connection source could not be verified and cannot act as owner. / 本请求的连接来源查不出，不能以 owner 身份执行。' }
        absent = true
        expect(connection.admit(request())).toEqual(unknown)
        absent = false
        inaccessible = true
        expect(connection.admit(request())).toEqual(unknown)
      } finally { await connection.browserPeer.dispose() }
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses product execution before registration without creating a Job', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const ctx = new Context()
    try {
      const fiber = ctx.plugin(LocalSubprocessRuntime)
      await fiber.await()
      expect(() => ctx.subprocess.spawn({
        argv: ['trusted-runner'], cwd: process.cwd(), productSandbox: true, graceMs: 1,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
      })).toThrow('Windows product source is not registered')
      expect(native.create).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('registers before ordinary and terminal launches and marks only product requests', async () => {
    const { ctx, registry } = prepare()
    const stopped = new Error('fixture launch stopped')
    native.launch.mockImplementation(() => { expect(registry.classify(undefined)).toBe('product-sandbox'); throw stopped })
    native.terminal.mockImplementation(() => { expect(registry.classify(undefined)).toBe('product-sandbox'); throw stopped })
    try {
      const fiber = ctx.plugin(LocalSubprocessRuntime)
      await fiber.await()
      const runtime = ctx.subprocess as LocalSubprocessRuntime
      runtime.terminalInspector = {
        foregroundPgid: () => undefined, isStdinWaiting: () => false,
        snapshot: () => ({ tree: () => [], session: () => [], alive: () => false }),
        isAlive: () => false, signalGroup: () => {}, signalProcess: () => {},
      }
      const ordinary = {
        argv: ['trusted-runner'], cwd: process.cwd(), graceMs: 1,
        env: { DSH_WINDOWS_PRODUCT_JOB: 'untrusted-locator', dsh_windows_product_job: 'case-alias' },
        stdio: { stdin: 'ignore' as const, stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
      }
      expect(() => runtime.spawn(ordinary)).toThrow(stopped)
      expect(native.create).not.toHaveBeenCalled()
      expect(native.launch.mock.calls.at(-1)?.[1]).not.toHaveProperty('DSH_WINDOWS_PRODUCT_JOB')
      expect(native.launch.mock.calls.at(-1)?.[1]).not.toHaveProperty('dsh_windows_product_job')
      expect(() => runtime.spawn({ ...ordinary, productSandbox: true })).toThrow(stopped)
      expect(native.launch.mock.calls.at(-1)?.[1]).toHaveProperty('DSH_WINDOWS_PRODUCT_JOB', 'fixture-job')
      const terminal = { argv: ['trusted-runner'], cwd: process.cwd(), graceMs: 1, rows: 24, cols: 80, terminalType: 'dumb' }
      await expect(runtime.spawnTerminal(terminal)).rejects.toThrow(stopped)
      expect(native.create).toHaveBeenCalledOnce()
      await expect(runtime.spawnTerminal({ ...terminal, productSandbox: true })).rejects.toThrow(stopped)
      expect(native.create).toHaveBeenCalledTimes(2)
      expect(native.terminal.mock.calls.at(-1)?.[2]).toHaveProperty('env.DSH_WINDOWS_PRODUCT_JOB', 'fixture-job')
      expect(native.terminal.mock.calls.at(-1)?.[2]).toHaveProperty('useConptyDll', true)
    } finally { await ctx.fiber.dispose() }
  })

  it('attempts every retained Job close after an earlier close fails', async () => {
    const { ctx } = prepare()
    const owner = WindowsProductJobs.forHost(ctx)
    owner.prepare({})
    owner.prepare({})
    native.close.mockImplementationOnce(() => { throw new Error('fixture close failure') })
    const report = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await ctx.fiber.dispose()
    expect(native.close).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledOnce()
    expect(owner.classify(undefined)).toBe('unknown')
  })
  it('registers before execution and withdraws to unknown while retaining root identity', async () => {
    const { ctx, registry } = prepare()
    try {
      const fiber = ctx.plugin(LocalSubprocessRuntime)
      await fiber.await()
      expect(registry.classify(undefined)).toBe('product-sandbox')
      const owner = WindowsProductJobs.forHost(ctx)
      expect(owner.prepare({ NORMAL: 'value' })).toEqual({ NORMAL: 'value', DSH_WINDOWS_PRODUCT_JOB: 'fixture-job' })
      await fiber.dispose()
      expect(registry.classify(undefined)).toBe('unknown')
      expect(native.close).not.toHaveBeenCalled()
      WindowsProductJobs.forHost(ctx).classify(undefined)
      expect(native.lookup.mock.calls.at(-1)?.[1]).toEqual([9n])
      expect(native.create).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
    expect(native.close).toHaveBeenCalledOnce()
  })

  it.each(['inherited', 'piped', 'double-fork descendant'])('refuses a valid owner cookie from a %s and caches the connection', async () => {
    const { ctx, registry } = prepare()
    const credentials = new MemoryCredentials(ctx)
    try {
      const fiber = ctx.plugin(LocalSubprocessRuntime)
      await fiber.await()
      const source = new OwnerConnectionSource(socket => registry.classify(socket))
      const auth = await BrowserAuth.create(ctx, credentials, 30, () => true, source)
      const connection = new HostConnectionService(ctx, [], auth)
      try {
        const cookie = auth.desktopCookie('http://localhost')
        const request = { headers: { host: 'localhost', cookie }, socket: new EventEmitter() }
        const refusal = { rejection: 403, reason: 'This request comes from a sandbox process and cannot act as owner. / 本请求来自沙箱进程，不能以 owner 身份执行。' }
        expect(connection.admit(request)).toEqual(refusal)
        expect(connection.admit(request)).toEqual(refusal)
        expect(native.lookup).toHaveBeenCalledOnce()
        for (const browser of ['Edge LPAC', 'Chrome network service', 'Firefox main']) {
          native.lookup.mockReturnValue('non-product')
          const external = { ...request, socket: Object.assign(new EventEmitter(), { browser }) }
          expect(connection.admit(external)).toEqual({ peer: connection.browserPeer })
        }
        native.lookup.mockReturnValue('unknown')
        expect(connection.admit({ ...request, socket: new EventEmitter() })).toEqual({ rejection: 403, reason: 'The connection source could not be verified and cannot act as owner. / 本请求的连接来源查不出，不能以 owner 身份执行。' })
      } finally { await connection.browserPeer.dispose() }
    } finally { await ctx.fiber.dispose() }
  })
})
