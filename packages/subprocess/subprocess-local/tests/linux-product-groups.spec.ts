import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { LinuxProductGroups } from '../src/linux-product-groups.ts'

const host = vi.hoisted(() => ({
  access: vi.fn(), read: vi.fn(), stat: vi.fn(), entries: vi.fn(), exists: vi.fn(),
  write: vi.fn(), rename: vi.fn(), remove: vi.fn(), create: vi.fn(), probe: vi.fn(), query: vi.fn(),
}))

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  accessSync: host.access, readFileSync: host.read, statSync: host.stat,
  readdirSync: host.entries, existsSync: host.exists, writeFileSync: host.write,
  renameSync: host.rename, rmdirSync: host.remove, mkdtempSync: host.create,
}))
vi.mock('@panedesk/node-addon-system/socket-cgroup', () => ({
  loadSocketCgroupQuery: () => ({ probe: host.probe, query: host.query }),
}))

const files = { directory: '/private/launch', requestPath: '/private/launch/launch-request.json',
  startupErrorPath: '/private/launch/startup-error.json' }
const group = '/sys/fs/cgroup/session/example.scope/panedesk-product'
const socket = { remoteAddress: 'client', remotePort: 1234, localAddress: 'server', localPort: 4321 }

beforeEach(() => {
  vi.useFakeTimers()
  host.probe.mockReturnValue(true)
  host.access.mockReturnValue(undefined)
  host.create.mockReturnValue('/sys/fs/cgroup/session/dsh-attribution-probe-fixture')
  host.exists.mockReturnValue(true)
  host.stat.mockReturnValue({ ino: 10n })
  host.entries.mockReturnValue([])
  host.query.mockReturnValue(10n)
  host.read.mockImplementation((path: string) => {
    if (path === '/proc/self/cgroup') return '0::/session\n'
    if (path === '/proc/321/cgroup') return '0::/session/example.scope/panedesk-product\n'
    if (path.endsWith('cgroup-ready.json')) return JSON.stringify({ pid: 321 })
    if (path.endsWith('cgroup.events')) return 'populated 0\n'
    throw new Error('Unexpected fixture read')
  })
})
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

function registered() {
  const groups = LinuxProductGroups.probe()
  expect(groups).toBeDefined()
  if (groups === undefined) throw new Error('Fixture requires attribution')
  const release = groups.prepare(files, 'example.scope')
  vi.advanceTimersByTime(5)
  return { groups, release }
}

describe('Linux product socket attribution', () => {
  it('starts and identifies product groups after more than 65536 completed launches', () => {
    const groups = LinuxProductGroups.probe()
    if (groups === undefined) throw new Error('Fixture requires attribution')
    let identity = 100n
    host.stat.mockImplementation(() => ({ ino: identity }))
    for (let index = 0; index < 65537; index++) {
      const release = groups.prepare(files, 'example.scope')
      vi.advanceTimersByTime(5)
      release()
      identity++
      vi.clearAllMocks()
    }
    const release = groups.prepare(files, 'example.scope')
    vi.advanceTimersByTime(5)
    host.query.mockReturnValue(identity)
    expect(groups.classify(socket)).toBe('product-sandbox')
    release()
    host.query.mockReturnValue(100n)
    host.stat.mockReturnValue({ ino: 1n })
    expect(groups.classify(socket)).toBe('unknown')
    expect(host.stat.mock.calls.length).toBeLessThan(10)
    // Reappearance of an evicted full-width identity is not proof of a new owner.
    host.stat.mockReturnValue({ ino: 100n })
    expect(groups.classify(socket)).toBe('unknown')
  })

  it('probes socket support before checking delegation and refuses missing delegation', () => {
    host.probe.mockReturnValue(false)
    expect(LinuxProductGroups.probe()).toBeUndefined()
    expect(host.access).not.toHaveBeenCalled()
    host.probe.mockReturnValue(true)
    host.access.mockImplementation(() => { throw new Error('No delegation') })
    expect(LinuxProductGroups.probe()).toBeUndefined()
  })

  it('publishes the acknowledgement only after writing its complete private record', () => {
    const { groups } = registered()
    expect(host.write).toHaveBeenCalledWith('/private/launch/cgroup-ack.pending', 'registered\n', { flag: 'wx', mode: 0o600 })
    expect(host.rename).toHaveBeenCalledWith('/private/launch/cgroup-ack.pending', '/private/launch/cgroup-ack')
    expect(host.write.mock.invocationCallOrder[0]).toBeLessThan(host.rename.mock.invocationCallOrder[0]!)
    expect(groups.classify(socket)).toBe('product-sandbox')
  })

  it('recognizes descendant groups without classifying an unrelated group as product', () => {
    const { groups } = registered()
    host.query.mockReturnValue(11n)
    host.stat.mockImplementation((path: string) => ({ ino: path === group ? 10n : 11n }))
    host.entries.mockImplementation((path: string) => path === group ? [{ name: 'child', isDirectory: () => true }] : [])
    expect(groups.classify(socket)).toBe('product-sandbox')
    host.query.mockReturnValue(12n)
    host.stat.mockImplementation((path: string) => ({ ino: path === '/sys/fs/cgroup' ? 12n : path === group ? 10n : 11n }))
    expect(groups.classify(socket)).toBe('non-product')
    host.query.mockReturnValue(13n)
    expect(groups.classify(socket)).toBe('unknown')
  })

  it('fails closed when a disappearing sibling interrupts descendant enumeration', () => {
    const { groups } = registered()
    host.query.mockReturnValue(11n)
    host.entries.mockReturnValue([{ name: 'vanished', isDirectory: () => true }, { name: 'live', isDirectory: () => true }])
    host.stat.mockImplementation((path: string) => {
      if (path.endsWith('/vanished')) throw Object.assign(new Error('Gone'), { code: 'ENOENT' })
      return { ino: path.endsWith('/live') ? 11n : 10n }
    })
    expect(groups.classify(socket)).toBe('unknown')
  })

  it('fails closed on a per-connection query error despite a successful capability probe', () => {
    const { groups } = registered()
    host.query.mockImplementation(() => { throw new Error('Query failed') })
    expect(groups.classify(socket)).toBe('unknown')
    expect(groups.classify(undefined)).toBe('unknown')
  })

  it('keeps transferred socket identities after the process range is removed', () => {
    const { groups, release } = registered()
    release()
    expect(host.remove).toHaveBeenCalledWith(group)
    expect(groups.classify(socket)).toBe('product-sandbox')
  })

  it('keeps one identity owner for a host but never shares it with another host', async () => {
    const first = new Context()
    const second = new Context()
    try {
      expect(LinuxProductGroups.forHost(first.extend())).toBe(LinuxProductGroups.forHost(first.extend()))
      // Negated toBe computes deep-equality diagnostics for the large identity buffers.
      expect(Object.is(LinuxProductGroups.forHost(first), LinuxProductGroups.forHost(second))).toBe(false)
    } finally {
      await first.fiber.dispose()
      await second.fiber.dispose()
    }
  })

  it('retains registration when a populated group cannot be released', () => {
    const { groups, release } = registered()
    host.read.mockReturnValue('populated 1\n')
    expect(release).toThrow('Cannot release a populated product cgroup')
    expect(host.remove).not.toHaveBeenCalledWith(group)
    expect(groups.classify(socket)).toBe('product-sandbox')
  })
})
