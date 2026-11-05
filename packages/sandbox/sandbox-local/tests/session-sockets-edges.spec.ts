import * as fs from 'node:fs'
import * as os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasHostSessionSockets, sessionSocketDirectories } from '../src/session-sockets.ts'

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('session socket discovery edge observations', () => {
  it('ignores relative overrides and never connects to discovered endpoints', () => {
    vi.stubEnv('TMUX_TMPDIR', 'relative-tmux')
    vi.stubEnv('XDG_RUNTIME_DIR', 'relative-runtime')
    const directories = sessionSocketDirectories()
    expect(directories).not.toContain('relative-tmux')
    expect(directories).not.toContain('relative-runtime')
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    expect(hasHostSessionSockets()).toBe(false)
    const info = os.userInfo()
    expect(exists.mock.calls.map(call => call[0])).toEqual([`/tmp/tmux-${info.uid}`, `/run/screen/S-${info.username}`, `/run/user/${info.uid}/bus`])
  })
  it('accepts an absolute session override and short-circuits after the first existing socket path', () => {
    vi.stubEnv('TMUX_TMPDIR', '/tmp/socket-discovery-fixture')
    const exists = vi.spyOn(fs, 'existsSync').mockImplementation(path => path === '/tmp/socket-discovery-fixture')
    expect(hasHostSessionSockets()).toBe(true)
    expect(exists).toHaveBeenCalledTimes(4)
    exists.mockClear().mockReturnValue(true)
    expect(hasHostSessionSockets()).toBe(true)
    expect(exists).toHaveBeenCalledOnce()
  })
})
