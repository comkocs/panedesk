import { Context } from '@panedesk/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinuxProductGroups } from '../src/linux-product-groups.ts'

const host = vi.hoisted(() => ({
  access: vi.fn(), read: vi.fn(), stat: vi.fn(), entries: vi.fn(), exists: vi.fn(),
  write: vi.fn(), rename: vi.fn(), remove: vi.fn(), create: vi.fn(), probe: vi.fn(), query: vi.fn(),
}))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), accessSync: host.access, readFileSync: host.read, statSync: host.stat, readdirSync: host.entries, existsSync: host.exists, writeFileSync: host.write, renameSync: host.rename, rmdirSync: host.remove, mkdtempSync: host.create }))
vi.mock('@panedesk/node-addon-system/socket-cgroup', () => ({ loadSocketCgroupQuery: () => ({ probe: host.probe, query: host.query }) }))
const files = { directory: '/private/launch', requestPath: '/private/launch/request', startupErrorPath: '/private/launch/error' }
const group = '/sys/fs/cgroup/session/example.scope/panedesk-product'
const socket = { remoteAddress: 'client', remotePort: 1234, localAddress: 'server', localPort: 4321 }
function read(path: string): string {
  if (path === '/proc/self/cgroup') return '0::/session\n'
  if (path === '/proc/321/cgroup') return '0::/session/example.scope/panedesk-product\n'
  if (path.endsWith('cgroup-ready.json')) return JSON.stringify({ pid: 321 })
  if (path.endsWith('cgroup.events')) return 'populated 0\n'
  throw new Error('Unexpected read')
}
beforeEach(() => {
  vi.useFakeTimers()
  host.probe.mockReturnValue(true)
  host.exists.mockReturnValue(true)
  host.stat.mockReturnValue({ ino: 10n })
  host.entries.mockReturnValue([])
  host.query.mockReturnValue(10n)
  host.create.mockReturnValue('/sys/fs/cgroup/session/probe')
  host.read.mockImplementation(read)
})
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })
function owner(): LinuxProductGroups {
  const groups = LinuxProductGroups.probe()
  if (groups === undefined) throw new Error('Fixture requires attribution')
  return groups
}

describe('Linux product attribution incomplete observations', () => {
  it('refuses missing unified membership during the capability probe', () => {
    host.read.mockReturnValue('1:legacy:/session\n')
    expect(LinuxProductGroups.probe()).toBeUndefined()
    expect(host.create).not.toHaveBeenCalled()
  })
  it('refuses every incomplete physical tuple and normalizes mapped addresses', () => {
    const groups = owner()
    for (const missing of ['remoteAddress', 'remotePort', 'localAddress', 'localPort'] as const) {
      expect(groups.classify({ ...socket, [missing]: undefined })).toBe('unknown')
    }
    expect(host.query).not.toHaveBeenCalled()
    expect(groups.classify({ ...socket, remoteAddress: '::ffff:client', localAddress: '::ffff:server' })).toBe('non-product')
    expect(host.query).toHaveBeenCalledExactlyOnceWith({ sourceAddress: 'client', sourcePort: 1234, destinationAddress: 'server', destinationPort: 4321 })
  })
  it('expires an unobserved readiness file without publishing an acknowledgement', () => {
    const groups = owner()
    host.exists.mockReturnValue(false)
    const release = groups.prepare(files, 'example.scope')
    vi.advanceTimersByTime(5000)
    host.exists.mockReturnValue(true)
    vi.advanceTimersByTime(5)
    release()
    expect(host.write).not.toHaveBeenCalled()
    expect(host.remove).toHaveBeenCalledTimes(1)
  })
  it.each(['null', '1', '{}', '{"pid":"321"}', '{"pid":1.5}', '{"pid":0}'])(
    'withholds acknowledgement for malformed readiness %s', (value) => {
      const groups = owner()
      host.read.mockImplementation((path: string) => path.endsWith('cgroup-ready.json') ? value : read(path))
      const release = groups.prepare(files, 'example.scope')
      vi.advanceTimersByTime(5)
      release()
      expect(host.write).not.toHaveBeenCalled()
    },
  )
  it.each(['0::/session/foreign.scope/panedesk-product\n', '0::/session/example.scope/other\n'])(
    'withholds acknowledgement outside the exact owned scope: %s', (membership) => {
      const groups = owner()
      host.read.mockImplementation((path: string) => path === '/proc/321/cgroup' ? membership : read(path))
      const release = groups.prepare(files, 'example.scope')
      vi.advanceTimersByTime(5)
      release()
      expect(host.write).not.toHaveBeenCalled()
    },
  )
  it('retains every descendant identity when removing an empty product range', () => {
    const groups = owner()
    const release = groups.prepare(files, 'example.scope')
    vi.advanceTimersByTime(5)
    host.entries.mockImplementation((path: string) => path === group ? [{ name: 'child', isDirectory: () => true }, { name: 'cgroup.events', isDirectory: () => false }] : [])
    host.stat.mockImplementation((path: string) => ({ ino: path.endsWith('/child') ? 11n : 10n }))
    release()
    expect(host.remove.mock.calls.slice(-2)).toEqual([[group + '/child'], [group]])
    host.query.mockReturnValue(11n)
    expect(groups.classify(socket)).toBe('product-sandbox')
  })
  it('accepts a vanished released group but propagates another removal failure', () => {
    for (const code of ['ENOENT', 'EACCES']) {
      const groups = owner()
      const release = groups.prepare(files, 'example.scope')
      vi.advanceTimersByTime(5)
      host.remove.mockImplementation(() => { throw Object.assign(new Error('Removal failed'), { code }) })
      if (code === 'ENOENT') expect(release).not.toThrow()
      else expect(release).toThrow('Removal failed')
      host.remove.mockReset()
    }
  })
  it('bounds a recursive classification before granting nonmembership', () => {
    const groups = owner()
    host.query.mockReturnValue(99n)
    host.entries.mockReturnValue(Array.from({ length: 4097 }, (_, index) => ({ name: String(index), isDirectory: () => true })))
    let count = 0
    host.stat.mockImplementation(() => { count++; return { ino: 10n } })
    host.entries.mockImplementation((path: string) => path === '/sys/fs/cgroup' ? Array.from({ length: 4097 }, (_, index) => ({ name: String(index), isDirectory: () => true })) : [])
    expect(groups.classify(socket)).toBe('unknown')
    expect(count).toBe(4096)
  })
  it('owns unavailable attribution once per root context', async () => {
    host.probe.mockReturnValue(false)
    const ctx = new Context()
    try {
      expect(LinuxProductGroups.forHost(ctx)).toBeUndefined()
      expect(LinuxProductGroups.forHost(ctx)).toBeUndefined()
      expect(host.probe).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
})
