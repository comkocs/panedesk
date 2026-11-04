/** Product-home inputs remain protected unless their exact runtime path is excluded. */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

async function fixture(diagnostics = true) {
  const workspace = mkdtempSync(join(tmpdir(), 'protected-product-home-'))
  const home = join(workspace, '.panedesk')
  mkdirSync(home)
  onTestFinished(() => { rmSync(workspace, { recursive: true, force: true }) })
  const write = (path: string, value: string) => {
    const filename = join(home, path)
    mkdirSync(dirname(filename), { recursive: true })
    writeFileSync(filename, value)
  }
  for (const path of ['config.json', 'cordis.patch.yml', 'profiles/active/plugins/entry.js']) write(path, 'approved')
  mkdirSync(join(home, 'run'))
  mkdirSync(join(home, 'logs'))
  if (diagnostics) {
    for (const path of ['run/kernel-boot.json', 'run/kernel-status.json', 'logs/host-errors.log']) write(path, 'initial runtime state')
  }
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(home)
  await integrity.grantWrite([home])
  const owner = { blocked: vi.fn(), confirm: vi.fn(async () => false) }
  return { home, integrity, owner, write }
}

it.each(['config.json', 'cordis.patch.yml', 'profiles/active/plugins/entry.js'])(
  'rejects a changed product-home input: %s', async (path) => {
    const f = await fixture()
    f.write(path, 'unapproved')
    await expect(f.integrity.verify(f.owner)).resolves.toBe(false)
    expect(f.owner.blocked).toHaveBeenCalledOnce()
  },
)

it.each(['run/kernel-boot.json', 'run/kernel-status.json', 'logs/host-errors.log'])(
  'accepts host diagnostic updates after capture: %s', async (path) => {
    const f = await fixture()
    f.write(path, 'updated runtime state')
    await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
    expect(f.owner.blocked).not.toHaveBeenCalled()
  },
)

it('accepts newly written listed diagnostic files in existing protected directories', async () => {
  const f = await fixture(false)
  for (const path of ['run/kernel-boot.json', 'run/kernel-status.json', 'logs/host-errors.log']) f.write(path, 'new runtime state')
  await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
  expect(f.owner.blocked).not.toHaveBeenCalled()
})

it('keeps an unlisted alias to a diagnostic file protected', async () => {
  const f = await fixture()
  symlinkSync(join(f.home, 'run/kernel-status.json'), join(f.home, 'unlisted-input'))
  await expect(f.integrity.verify(f.owner)).resolves.toBe(false)
  expect(f.owner.blocked).toHaveBeenCalledOnce()
})

it.each(['directory', 'link'])('rejects a diagnostic filename replaced by a %s', async (kind) => {
  const f = await fixture()
  const path = join(f.home, 'run/kernel-status.json')
  rmSync(path)
  if (kind === 'directory') {
    mkdirSync(path)
    writeFileSync(join(path, 'input.js'), 'unapproved')
  } else symlinkSync(join(f.home, 'config.json'), path)
  await expect(f.integrity.verify(f.owner)).resolves.toBe(false)
  expect(f.owner.blocked).toHaveBeenCalledOnce()
})

it('rejects a new unlisted product-home file after capture', async () => {
  const f = await fixture()
  f.write('new-host-input.json', 'unapproved')
  await expect(f.integrity.verify(f.owner)).resolves.toBe(false)
  expect(f.owner.blocked).toHaveBeenCalledOnce()
})
