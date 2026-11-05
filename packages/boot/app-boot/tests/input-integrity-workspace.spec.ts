/** Workspace grants must not recapture an unrelated reader's protected inputs. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'
import { grantProtectedWorkspace } from '../src/profile-context.ts'
import type { ProfileContext } from '../src/profile-context-types.ts'

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }))

it.each(['host writes', 'directory link', 'directory type'] as const)(
  'selects the workspace owner record during capture with concurrent %s', async (change) => {
    const workspace = mkdtempSync(join(tmpdir(), 'protected-workspace-owner-'))
    onTestFinished(() => { vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }) })
    const home = join(workspace, '.panedesk')
    const dir = join(home, 'profiles', 'headless')
    const tree = join(home, 'storages', 'session_projcache', 'sessions')
    const child = join(tree, 'active')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    mkdirSync(child, { recursive: true, mode: 0o700 })
    const previous = join(child, 'previous.json')
    writeFileSync(previous, 'previous host state', { mode: 0o600 })
    const patchPath = join(dir, 'cordis.patch.yml')
    writeFileSync(patchPath, '[]')
    const input = join(home, 'refused-input.txt')
    writeFileSync(input, 'approved')
    const integrity = new ProtectedInputIntegrity(home)
    integrity.observe(input)
    writeFileSync(input, 'unapproved')
    const context: ProfileContext = {
      name: 'headless', cwd: workspace, home, dir, patchPath, installAnchor: join(dir, 'package.json'),
      overlays: [], startedBundles: [], telemetryDisabledEnv: undefined, inputIntegrity: integrity,
    }
    const original = fs.openSync
    let changed = false
    const opened = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (args[0] === patchPath && args[1] === 'r' && !changed) {
        changed = true
        if (change === 'host writes') {
          fs.unlinkSync(previous)
          writeFileSync(join(child, 'current.json'), 'current host state', { mode: 0o600 })
        } else {
          rmSync(child, { recursive: true })
          if (change === 'directory link') symlinkSync(dir, child, 'dir')
          else { rmSync(tree, { recursive: true }); writeFileSync(tree, 'not a directory', { mode: 0o600 }) }
        }
      }
      return original(...args)
    })
    const capture = grantProtectedWorkspace(context, workspace, [home])
    if (change === 'host writes') {
      await expect(capture).resolves.toBeUndefined()
      expect(opened.mock.calls.filter(([path, flags]) => flags === 'r' && String(path).startsWith(tree + '/'))).toHaveLength(0)
      const owner = { blocked: vi.fn(), confirm: vi.fn(async () => false) }
      expect(await integrity.verify(owner)).toBe(false)
      expect(owner.blocked).toHaveBeenCalledOnce()
      expect(new ProtectedInputIntegrity(workspace, home).covers(patchPath)).toBe(true)
    } else await expect(capture).rejects.toThrow('Protected authoritative home tree')
    expect(changed).toBe(true)
  },
)
