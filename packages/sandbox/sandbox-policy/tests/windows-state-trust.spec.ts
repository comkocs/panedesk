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
  windowsAcl.entries.push({ path: f.root, sid: 'S-1-1-0', deny: false, recursive: false, rights: [right] })
  expect(new WorkspaceWriteAccess(f.home).isAuthorized(f.workspace)).toBe(false)
  const materialize = vi.fn()
  await expect(f.access.withAuthorization(f.workspace, materialize)).rejects.toThrow()
  expect(materialize).not.toHaveBeenCalled()
})

it('refuses first consent without changing ACLs when the logon SID can append at an ancestor', async () => {
  const f = fixture()
  windowsAcl.entries.push({ path: f.root, sid: 'S-1-5-5-1-2', deny: false, recursive: false, rights: ['append'] })
  await expect(f.access.authorize(f.workspace, 'first-confirmation')).rejects.toThrow(f.root)
  expect(f.access.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
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
