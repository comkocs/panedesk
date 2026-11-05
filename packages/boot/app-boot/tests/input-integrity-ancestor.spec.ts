/** Ancestor input roots retain the product home's exact mutable-tree classification. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'protected-home-ancestor-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }) })
  const home = join(workspace, 'home')
  const write = (path: string, value: string) => {
    const filename = join(workspace, path)
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
    writeFileSync(filename, value, { mode: 0o600 })
    return filename
  }
  write('plugin.mjs', 'export const name = "local-plugin"')
  write('home/config.json', '{}')
  for (const tree of ['ledger', 'sessions', 'storages/session_projcache/sessions']) write(`home/${tree}/state.json`, 'initial')
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(workspace)
  integrity.observe(home)
  const owner = { blocked: vi.fn(), confirm: vi.fn(async () => false) }
  return { workspace, home, write, integrity, owner }
}

it('captures a plugin ancestor without reading authoritative home bytes', async () => {
  const f = fixture()
  const original = fs.openSync
  const opened = vi.spyOn(fs, 'openSync').mockImplementation((...args) => original(...args))
  await f.integrity.grantWrite([f.home])
  expect(opened.mock.calls.filter(([path, flags]) => flags === 'r' && String(path).endsWith('/state.json'))).toHaveLength(0)
})

it('accepts authoritative home updates through an overlapping plugin ancestor after reopening', async () => {
  const f = fixture()
  await f.integrity.grantWrite([f.home])
  for (const tree of ['ledger', 'sessions', 'storages/session_projcache/sessions']) {
    f.write(`home/${tree}/state.json`, 'updated')
    f.write(`home/${tree}/new.json`, 'new')
  }
  const reopened = new ProtectedInputIntegrity(f.workspace, f.home)
  await expect(reopened.verify(f.owner)).resolves.toBe(true)
  expect(f.owner.blocked).not.toHaveBeenCalled()
})

it.each(['plugin.mjs', 'home/config.json', 'home/unlisted.json', 'ledger/state.json'])(
  'keeps ancestor inputs outside the exact authoritative home trees protected: %s', async (path) => {
    const f = fixture()
    await f.integrity.grantWrite([f.home])
    f.write(path, 'unapproved')
    await expect(f.integrity.verify(f.owner)).resolves.toBe(false)
    expect(f.owner.blocked).toHaveBeenCalled()
  },
)

it('rejects unsafe authoritative structure reached through a plugin ancestor', async () => {
  const f = fixture()
  await f.integrity.grantWrite([f.home])
  chmodSync(join(f.home, 'ledger/state.json'), 0o660)
  await expect(f.integrity.verify(f.owner)).rejects.toThrow('Protected authoritative home tree')
  expect(f.owner.confirm).not.toHaveBeenCalled()
})
