/** Unsafe Windows state never supplies trusted launch bytes or grants a fresh baseline. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

const state = vi.hoisted(() => ({ unsafe: false }))
vi.mock('@panedesk/dsh-sandbox-windows-acl', async (original) => {
  const actual = await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>()
  return { ...actual, assertWindowsStateTrusted: (directory: string) => {
    if (state.unsafe) throw new actual.UnsafeWindowsStateError(directory, 2)
  } }
})

it('omits untrusted recorded and current configuration but keeps read-only reads available', async () => {
  const root = mkdtempSync(join(tmpdir(), 'windows-record-trust-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  mkdirSync(home)
  const input = join(workspace, 'cordis.patch.yml')
  writeFileSync(input, 'approved')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  onTestFinished(() => { state.unsafe = false; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const initial = new ProtectedInputIntegrity(workspace, home)
  initial.observe(input)
  await initial.grantWrite()
  writeFileSync(input, 'attacker current bytes')
  state.unsafe = true
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const reopened = ProtectedInputIntegrity.openOwnerRecords(workspace, home)
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('UnsafeWindowsStateError:'))
  expect(reopened.readTrusted(input)).toBeUndefined()
  expect(() => reopened.readExecutable(input)).toThrow('Windows owner state')
  expect(() => reopened.grantWrite()).toThrow('Windows owner state')
  expect(initial.readTrusted(input)).toBeUndefined()
  const owner = { confirm: vi.fn(async () => true), blocked: vi.fn() }
  expect(await initial.verify(owner)).toBe(false)
  expect(owner.confirm).not.toHaveBeenCalled()
  const external = join(root, 'external.yml')
  writeFileSync(external, 'trusted external config')
  expect(reopened.readTrusted(external)?.toString()).toBe('trusted external config')
})
