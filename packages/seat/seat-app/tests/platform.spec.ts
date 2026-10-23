/** Windows path, permission and watch stubs only; Windows has not been run. */
import { afterEach, expect, it, vi } from 'vitest'
import { win32 } from 'node:path'

const stubs = vi.hoisted(() => ({ realpath: vi.fn<(path: string) => Promise<string>>(), watch: vi.fn(),
  execute: vi.fn<(command: string, args: string[], options: object,
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => void>() }))
vi.mock('node:child_process', () => ({ execFile: stubs.execute }))
vi.mock('node:path', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:path')>()
  return { ...original, default: original.win32 }
})
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), realpath: stubs.realpath,
}))
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(), watch: stubs.watch,
}))
import { canonicalPath, containsPath } from '../../seat-local/src/identity.ts'
import { GitTrigger } from '../../seat-engine/src/git-trigger.ts'
import { EngineJournal } from '@panedesk/dsh-seat-engine'
import type * as T from '@panedesk/dsh-seat'
import { EventEmitter } from 'node:events'

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

it('closes Windows watch stubs and reports asynchronous permission failures', async () => {
  const watchers: (EventEmitter & { close: ReturnType<typeof vi.fn> })[] = []
  stubs.watch.mockImplementation(() => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
    watchers.push(watcher)
    return watcher
  })
  stubs.execute.mockImplementation((_command, args, _options, callback) => {
    callback(null, { stdout: args[0] === 'rev-parse' ? 'C:\\Seats\\repo-a\\.git\n' : '', stderr: '' })
  })
  const journal = new EngineJournal('unused', 'node-a' as T.SeatNodeId, 100000)
  const errors: unknown[] = []
  const trigger = new GitTrigger({ repository: 'C:\\Seats\\repo-a', repositoryId: 'repo-a' as never,
    ref: 'refs/heads/main', checkpoint: 'unused', journal, fallbackMs: 60000,
    accept: async () => { throw new Error('Unexpected ingress') }, onError: error => errors.push(error) })
  vi.spyOn(trigger, 'scan').mockResolvedValue()
  try {
    await trigger.start()
    const error = Object.assign(new Error('Watch permission denied'), { code: 'EACCES' })
    watchers[0]!.emit('error', error)
    expect(errors).toEqual([error])
    expect(watchers).toHaveLength(2)
  } finally { await trigger.stop() }
  expect(watchers.every(watcher => watcher.close.mock.calls.length === 1)).toBe(true)
})

it.each([
  ['C:\\Seats\\seat-a', 'c:\\seats\\SEAT-A\\notes.md', true],
  ['C:\\Seats\\seat-a', 'C:\\Seats\\seat-ab\\notes.md', false],
  ['C:\\Seats\\seat-a', 'D:\\Seats\\seat-a', false],
  ['\\\\server-a\\share\\seat-a', '\\\\server-a\\share\\seat-a\\notes.md', true],
  ['C:\\Seats\\seat-a', 'C:\\Seats\\seat-a\\..\\seat-b', false],
])('uses explicit Windows containment rules for %s and %s', (root, target, allowed) => {
  expect(containsPath(root, target, 'win32')).toBe(allowed)
})

it('preserves Windows permission refusal instead of treating it as a missing ancestor', async () => {
  const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' })
  stubs.realpath.mockRejectedValue(error)
  await expect(canonicalPath('C:\\Seats\\seat-a\\notes.md')).rejects.toBe(error)
  expect(stubs.realpath).toHaveBeenCalledTimes(1)
})

it('resolves an absent Windows leaf through its existing ancestor', async () => {
  stubs.realpath.mockRejectedValueOnce(Object.assign(new Error('Missing leaf'), { code: 'ENOENT' }))
    .mockResolvedValueOnce('C:\\Canonical\\seat-a')
  expect(await canonicalPath('C:\\Seats\\seat-a\\notes.md')).toBe(win32.join('C:\\Canonical\\seat-a', 'notes.md'))
  expect(stubs.realpath.mock.calls.map(([path]) => path)).toEqual(['C:\\Seats\\seat-a\\notes.md', 'C:\\Seats\\seat-a'])
})
