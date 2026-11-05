/** Mutable authoritative home trees retain structural protection without content baselines. */
import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

const trees = ['ledger', 'sessions', 'storages/session_projcache/sessions'] as const

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'protected-authority-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }) })
  const home = join(workspace, '.panedesk')
  const write = (path: string, value = 'host state') => {
    const filename = join(home, path)
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
    writeFileSync(filename, value, { mode: 0o600 })
    return filename
  }
  write('config.json', 'approved')
  for (const tree of trees) write(`${tree}/initial.json`)
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(home)
  const owner = { blocked: vi.fn(), confirm: vi.fn(async () => false) }
  return { workspace, home, write, integrity, owner }
}

it.each(trees)('accepts host updates and new files in the authoritative tree %s', async (tree) => {
  const f = fixture()
  await f.integrity.grantWrite([f.home])
  f.write(`${tree}/initial.json`, 'updated host state')
  f.write(`${tree}/new/event.jsonl`, 'new event')
  await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
  const reopened = new ProtectedInputIntegrity(f.workspace, f.home)
  await expect(reopened.verify(f.owner)).resolves.toBe(true)
  expect(f.owner.blocked).not.toHaveBeenCalled()
  expect(f.owner.confirm).not.toHaveBeenCalled()
})

it.each(['capture', 'verify'] as const)('accepts host writes during asynchronous %s without reading authoritative bytes', async (operation) => {
  const f = fixture()
  if (operation === 'verify') await f.integrity.grantWrite([f.home])
  const original = fs.openSync
  let wrote = false
  const opened = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === join(f.home, 'config.json') && args[1] === 'r' && !wrote) {
      wrote = true
      for (const tree of trees) {
        f.write(`${tree}/initial.json`, 'host update during capture')
        f.write(`${tree}/new/event.jsonl`, 'host append')
      }
    }
    return original(...args)
  })
  if (operation === 'capture') await expect(f.integrity.grantWrite([f.home])).resolves.toBeUndefined()
  else await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
  expect(wrote).toBe(true)
  expect(opened.mock.calls.filter(([path, flags]) => flags === 'r' && trees.some(tree => String(path).startsWith(join(f.home, tree) + '/')))).toHaveLength(0)
  expect(f.owner.blocked).not.toHaveBeenCalled()
})

it.each(['new-unlisted.json', 'storages/session_projcache/unlisted.json', 'config.json'])(
  'rejects a changed or added input outside the three trees: %s', async (path) => {
    const f = fixture()
    await f.integrity.grantWrite([f.home])
    f.write(path, 'unapproved')
    await expect(f.integrity.verify(f.owner)).resolves.toBe(false)
    expect(f.owner.blocked).toHaveBeenCalledOnce()
  },
)

for (const platform of ['linux', 'darwin'] as const) {
  for (const operation of ['capture', 'verify'] as const) {
    it.each(['root-link', 'group-write', 'outside-link', 'outside-hard-link'] as const)(
      `rejects an unsafe authoritative %s during ${platform} ${operation}`, async (change) => {
        const f = fixture()
        vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
        if (operation === 'verify') await f.integrity.grantWrite([f.home])
        const tree = join(f.home, 'ledger')
        const outside = join(f.workspace, 'outside')
        mkdirSync(outside, { mode: 0o700 })
        if (change === 'root-link') {
          renameSync(tree, join(outside, 'moved'))
          symlinkSync(join(outside, 'moved'), tree, 'dir')
        } else if (change === 'group-write') chmodSync(join(tree, 'initial.json'), 0o660)
        else if (change === 'outside-link') symlinkSync(outside, join(tree, 'escape'), 'dir')
        else linkSync(join(tree, 'initial.json'), join(outside, 'alias'))
        const result = operation === 'capture' ? f.integrity.grantWrite([f.home]) : f.integrity.verify(f.owner)
        await expect(result).rejects.toThrow('Protected authoritative home tree')
        expect(f.owner.confirm).not.toHaveBeenCalled()
      },
    )
  }
}

it('accepts confined symbolic links and hard links within an authoritative tree', async () => {
  const f = fixture()
  const tree = join(f.home, 'ledger')
  symlinkSync('initial.json', join(tree, 'symbolic'))
  linkSync(join(tree, 'initial.json'), join(tree, 'hard'))
  await f.integrity.grantWrite([f.home])
  f.write('ledger/initial.json', 'updated')
  await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
  expect(f.owner.blocked).not.toHaveBeenCalled()
})

it('accepts creation of previously absent authoritative roots without excluding their parent inputs', async () => {
  const f = fixture()
  for (const tree of trees) rmSync(join(f.home, tree), { recursive: true })
  await f.integrity.grantWrite([f.home])
  for (const tree of trees) f.write(`${tree}/new.json`)
  await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
  expect(f.owner.blocked).not.toHaveBeenCalled()
})
