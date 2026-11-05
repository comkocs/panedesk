import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enterLinuxProductGroup } from '../src/linux-product-bootstrap.ts'

const host = vi.hoisted(() => ({ exists: vi.fn(), mkdir: vi.fn(), read: vi.fn(), rename: vi.fn(), write: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: host.exists, mkdirSync: host.mkdir, readFileSync: host.read, renameSync: host.rename, writeFileSync: host.write }))
const files = { directory: '/private/launch', requestPath: '/private/launch/request', startupErrorPath: '/private/launch/error' }
beforeEach(() => {
  host.exists.mockReturnValue(true)
  host.read.mockImplementation((path: string) => path === '/proc/self/cgroup' ? 'other\n0::/owned.scope\n' : 'registered\n')
})
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

describe('trusted Linux product bootstrap observations', () => {
  it('migrates and publishes readiness before accepting the host acknowledgement', () => {
    enterLinuxProductGroup(files)
    expect(host.mkdir).toHaveBeenCalledExactlyOnceWith('/sys/fs/cgroup/owned.scope/panedesk-product')
    expect(host.write).toHaveBeenNthCalledWith(1, '/sys/fs/cgroup/owned.scope/panedesk-product/cgroup.procs', String(process.pid))
    expect(host.write).toHaveBeenNthCalledWith(2, '/private/launch/cgroup-ready.pending', JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
    expect(host.rename).toHaveBeenCalledExactlyOnceWith('/private/launch/cgroup-ready.pending', '/private/launch/cgroup-ready.json')
  })
  it('refuses a host without unified membership before attempting migration', () => {
    host.read.mockReturnValue('1:legacy:/session\n')
    expect(() => { enterLinuxProductGroup(files) }).toThrow('requires unified cgroup membership')
    expect(host.mkdir).not.toHaveBeenCalled()
  })
  it('waits for a delayed host acknowledgement without executing target code', () => {
    host.exists.mockReturnValueOnce(false).mockReturnValue(true)
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    enterLinuxProductGroup(files)
    expect(wait).toHaveBeenCalledOnce()
    expect(host.read).toHaveBeenLastCalledWith('/private/launch/cgroup-ack', 'utf8')
  })
  it('refuses an expired registration interval and an invalid acknowledgement', () => {
    host.exists.mockReturnValue(false)
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(5000)
    expect(() => { enterLinuxProductGroup(files) }).toThrow('registration timed out before exec')
    host.exists.mockReturnValue(true)
    host.read.mockImplementation((path: string) => path === '/proc/self/cgroup' ? '0::/owned.scope\n' : 'unregistered\n')
    expect(() => { enterLinuxProductGroup(files) }).toThrow('acknowledgement is invalid')
  })
})
