import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { assertUnprotectedRoots, authoritativeHomeTrees, canonicalPath, isHomeDiagnosticFile, protectedWorkspaceBranches, SandboxProvider, SandboxUnavailableError } from '../src/index.ts'
import type { ConfinedArgv, SandboxPolicy } from '../src/index.ts'

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }))
afterEach(() => { vi.restoreAllMocks() })
function home(): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sandbox-roots-edges-')))
  onTestFinished(() => { fs.rmSync(root, { recursive: true, force: true }) })
  return root
}

describe('sandbox protected root edge observations', () => {
  it('lists only the three exact authoritative home trees', () => {
    const root = home()
    expect(authoritativeHomeTrees(root)).toEqual([join(root, 'ledger'), join(root, 'sessions'), join(root, 'storages/session_projcache/sessions')])
  })
  it('omits only exact regular diagnostic files without redirected ancestors', () => {
    const root = home()
    fs.mkdirSync(join(root, 'run')); fs.mkdirSync(join(root, 'logs'))
    for (const name of ['run/kernel-boot.json', 'run/kernel-status.json', 'logs/host-errors.log']) {
      const path = join(root, name)
      expect(isHomeDiagnosticFile(root, path)).toBe(false)
      fs.writeFileSync(path, '{}')
      expect(isHomeDiagnosticFile(root, path)).toBe(true)
      fs.unlinkSync(path)
      fs.mkdirSync(path)
      expect(isHomeDiagnosticFile(root, path)).toBe(false)
      fs.rmdirSync(path)
      fs.symlinkSync(join(root, 'run'), path)
      expect(isHomeDiagnosticFile(root, path)).toBe(false)
      fs.unlinkSync(path)
    }
    expect(isHomeDiagnosticFile(root, join(root, 'run/kernel-status.json.old'))).toBe(false)
    const actual = join(root, 'actual')
    fs.mkdirSync(actual)
    fs.writeFileSync(join(actual, 'kernel-status.json'), '{}')
    fs.rmdirSync(join(root, 'run'))
    fs.symlinkSync(actual, join(root, 'run'))
    expect(isHomeDiagnosticFile(root, join(root, 'run/kernel-status.json'))).toBe(false)
  })
  it('propagates nonmissing diagnostic and canonicalization failures', () => {
    const root = home()
    const failure = Object.assign(new Error('Observation denied'), { code: 'EACCES' })
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => { throw failure })
    expect(() => isHomeDiagnosticFile(root, join(root, 'run/kernel-status.json'))).toThrow(failure)
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw failure })
    expect(() => canonicalPath(join(root, 'blocked'))).toThrow(failure)
  })
  it('stops climbing when even the filesystem root is absent', () => {
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw Object.assign(new Error('No root'), { code: 'ENOENT' }) })
    expect(() => canonicalPath('/missing/ancestor')).toThrow('No root')
  })
  it('handles non-directory prefixes without losing the missing suffix', () => {
    const root = home()
    fs.writeFileSync(join(root, 'file'), 'state')
    expect(canonicalPath(join(root, 'file', 'child'))).toBe(join(root, 'file', 'child'))
  })
  it('rejects overlapping grants and deduplicates only contained workspace branches', () => {
    const root = home()
    const secret = join(root, 'state', 'secret')
    expect(() => { assertUnprotectedRoots([root], [secret]) }).toThrow('protected host path')
    expect(() => { assertUnprotectedRoots([secret], [root]) }).toThrow('protected host path')
    expect(() => { assertUnprotectedRoots([join(root, 'open')], [secret]) }).not.toThrow()
    expect(() => { assertUnprotectedRoots([root]) }).not.toThrow()
    expect(protectedWorkspaceBranches(root, [root, secret, join(root, 'state', 'other'), join(root, '..', 'outside')])).toEqual([join(root, 'state')])
  })
  it('reports unavailable runner details and the default workspace capability', async () => {
    class Provider extends SandboxProvider {
      confine(_argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> { return Promise.reject(new Error('Unused')) }
    }
    const ctx = new Context()
    try {
      const provider = new Provider(ctx)
      expect(provider.supportsWorkspaceWriteAccess).toBe(false)
      expect(new SandboxUnavailableError('read-only').message).not.toContain('Runner failure:')
      expect(new SandboxUnavailableError('workspace-write', 'probe refused').message).toContain('Runner failure: probe refused')
    } finally { await ctx.fiber.dispose() }
  })
})
