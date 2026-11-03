/** Real authorization records are inert when an ancestor grants the sandbox token write access. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { WorkspaceWriteAccess } from '../src/workspace-access.ts'
import { windowsAcl } from '../../../interaction/user-approval/tests/windows-acl-fixture.ts'

vi.mock('@panedesk/dsh-sandbox-windows-acl', async (original) => {
  const actual = await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>()
  const { inspectStateAncestors } = await import('../../sandbox-windows-acl/src/state-access.ts')
  const { windowsAcl: acl } = await import('../../../interaction/user-approval/tests/windows-acl-fixture.ts')
  return {
    ...actual,
    assertWindowsStateTrusted: (directory: string, workspace: string) => {
      const unsafe = inspectStateAncestors(directory, {
        permits: (path, mask) => acl.permitsToken(path, [actual.workspaceWriteSid(workspace)], mask),
      })
      if (unsafe !== undefined) throw new actual.UnsafeWindowsStateError(unsafe.path, unsafe.mask)
    },
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'windows-state-trust-'))
  const home = join(root, 'owner')
  const workspace = join(root, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  windowsAcl.reset()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  onTestFinished(() => { vi.restoreAllMocks(); windowsAcl.reset(); rmSync(root, { recursive: true, force: true }) })
  return { root, home, workspace, access: new WorkspaceWriteAccess(home) }
}

it.each(['write', 'append', 'delete', 'delete-child'] as const)('does not trust persisted consent through ancestor %s access', async (right) => {
  const f = fixture()
  await f.access.authorize(f.workspace, 'first-confirmation')
  windowsAcl.entries.push({ path: f.root, sid: 'S-1-1-0', deny: false, recursive: true, rights: [right] })
  expect(new WorkspaceWriteAccess(f.home).isAuthorized(f.workspace)).toBe(false)
  const materialize = vi.fn()
  await expect(f.access.withAuthorization(f.workspace, materialize)).rejects.toThrow()
  expect(materialize).not.toHaveBeenCalled()
})

it('refuses first consent without changing ACLs when the logon SID can append at the nearest existing parent', async () => {
  const f = fixture()
  windowsAcl.entries.push({ path: f.home, sid: 'S-1-5-5-1-2', deny: false, recursive: false, rights: ['append'] })
  await expect(f.access.authorize(f.workspace, 'first-confirmation')).rejects.toThrow(f.home)
  expect(f.access.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
})

it.each(['write-dac', 'write-owner'] as const)('refuses first consent with ancestor %s and allows it after removal', async (right) => {
  const f = fixture()
  windowsAcl.entries.push({ path: f.root, sid: 'S-1-1-0', deny: false, recursive: false, rights: [right] })
  await expect(f.access.authorize(f.workspace, 'first-confirmation')).rejects.toThrow(f.root)
  expect(f.access.find(f.workspace)).toBeUndefined()
  windowsAcl.entries.length = 0
  await f.access.authorize(f.workspace, 'first-confirmation')
  expect(f.access.isAuthorized(f.workspace)).toBe(true)
})

it('allows the default Windows user-profile chain but refuses inherited state writes', async () => {
  const f = fixture()
  const volume = join(f.root, 'C')
  const users = join(volume, 'Users')
  const user = join(users, 'Owner')
  const appData = join(user, 'AppData')
  const local = join(appData, 'Local')
  const home = join(local, 'Panedesk')
  mkdirSync(home, { recursive: true })
  // Default system-drive DACL: AU may create a directory on the volume itself,
  // not replace an existing user profile. Owner/SYSTEM/Administrators retain full control.
  for (const path of [volume, users, user, appData, local, home]) {
    windowsAcl.entries.push(
      { path, sid: 'S-1-5-21-1', deny: false, recursive: true, rights: ['read', 'write', 'append', 'delete', 'delete-child', 'write-dac', 'write-owner'] },
      { path, sid: 'S-1-1-0', deny: false, recursive: false, rights: ['read'] },
    )
  }
  windowsAcl.entries.push({ path: volume, sid: 'S-1-5-11', deny: false, recursive: false, rights: ['append'] })
  const access = new WorkspaceWriteAccess(home)
  await access.authorize(f.workspace, 'first-confirmation')
  expect(access.isAuthorized(f.workspace)).toBe(true)
  windowsAcl.entries.push({ path: home, sid: 'S-1-1-0', deny: false, recursive: true, rights: ['write'] })
  expect(access.isAuthorized(f.workspace)).toBe(false)
  await expect(access.authorize(f.workspace, 'first-confirmation')).rejects.toThrow()
})

it('does not reject unrelated trustees or inherited read-only entries', async () => {
  const f = fixture()
  windowsAcl.entries.push(
    { path: f.root, sid: 'S-1-5-21-99', deny: false, recursive: true, rights: ['write', 'append', 'delete', 'delete-child'] },
    { path: f.root, sid: 'S-1-1-0', deny: false, recursive: true, rights: ['read'] },
  )
  await f.access.authorize(f.workspace, 'first-confirmation')
  expect(f.access.isAuthorized(f.workspace)).toBe(true)
})
