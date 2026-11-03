/** Durable state may be nested only behind a native first-child write exclusion. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'
import { grantProtectedWorkspace } from '../src/profile-context.ts'
import type { ProfileContext } from '../src/profile-context-types.ts'

it.each(['linux', 'darwin'] as const)('establishes nested owner state behind the first protected child on %s', (platform) => {
  const workspace = mkdtempSync(join(tmpdir(), 'nested-owner-state-'))
  const home = join(workspace, '.panedesk', 'nested')
  const dir = join(home, 'profiles', 'active')
  mkdirSync(dir, { recursive: true })
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, '[]\n')
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }) })
  const profile: ProfileContext = {
    name: 'active', home, dir, patchPath, cwd: workspace, installAnchor: join(dir, 'package.json'),
    overlays: [], startedBundles: [], telemetryDisabledEnv: undefined,
    protectedInputPaths: () => [join(workspace, '.panedesk')],
  }
  expect(() => { grantProtectedWorkspace(profile, workspace, [join(workspace, '.panedesk')]) }).not.toThrow()
  const reopened = ProtectedInputIntegrity.openOwnerRecords(workspace, home)
  expect(reopened.readTrusted(patchPath)?.toString()).toBe('[]\n')
})

it('opens a Windows read-only session with nested state without granting write access', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'readonly-owner-state-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }) })
  const integrity = ProtectedInputIntegrity.openOwnerRecords(workspace, join(workspace, '.panedesk'))
  expect(integrity.covers(workspace)).toBe(false)
  expect(() => { integrity.grantWrite() }).toThrow('outside the writable workspace')
})
