/** Native hand-offs retain protected inputs without denying ordinary workspace writes. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { coveredContext } from './host-coverage-fixture.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { SessionId } from '@panedesk/dsh-session'

const native = vi.hoisted(() => ({ allows: [] as string[], denies: [] as { path: string; recursive: boolean }[] }))
vi.mock('@panedesk/dsh-sandbox-windows-acl', async (original) => {
  const actual = await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>()
  class AclWriteGrant {
    static create() { return new AclWriteGrant() }
    add(path: string) { native.allows.push(path) }
    protect(path: string, recursive = true) { native.denies.push({ path, recursive }) }
    has() { return true }
    dispose() {}
  }
  return { ...actual, AclWriteGrant }
})

const effects = ['overwrite/append/truncate', 'delete', 'rename input and ancestor', 'delete and recreate', 'create absent input', 'replace symlink/junction'] as const
for (const platform of ['linux', 'darwin', 'win32']) for (const effect of effects) {
  it(`${platform}: ${effect} preserves protected inputs and ordinary writes in the native hand-off`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-protected-matrix-'))
    const workspace = join(root, 'workspace')
    const parent = join(workspace, 'settings')
    const input = join(parent, 'config.yml')
    mkdirSync(parent, { recursive: true })
    if (effect === 'replace symlink/junction') {
      const target = join(root, 'owner.yml')
      writeFileSync(target, 'owner')
      symlinkSync(target, input)
    } else if (effect !== 'create absent input') writeFileSync(input, 'owner')
    const ctx = await coveredContext(workspace, input)
    onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
    native.allows = []; native.denies = []
    await ctx.plugin(LocalSandboxProvider)
    const provider = ctx.sandbox
    if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local sandbox provider missing')
    provider.internals = { platform, probeBwrap: () => true, windowsAclRunnerArgs: ['native-acl-runner'] }
    const handed = await provider.confine(['node', '-e', ''], {
      mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [input], sessionId: SessionId('protected-matrix'),
    })
    expect(handed.enforcement).toBe(platform === 'win32' ? 'partial' : 'full')
    const text = handed.argv.join('\n')
    if (platform === 'linux') {
      expect(text).toContain(['--bind', workspace, workspace].join('\n'))
      if (effect === 'replace symlink/junction') {
        expect(handed.argv.slice(1, 4)).toEqual(['--ro-bind', '/', '/'])
        expect(handed.argv).not.toContain(input)
        expect(handed.argv).not.toContain(join(root, 'owner.yml'))
      } else if (effect === 'create absent input') {
        expect(handed.argv).not.toContain(input)
        expect(handed.protectedInputs).toContainEqual({ path: input, enforcement: 'host-fallback', reason: 'unrepresentable' })
      } else {
        expect(text).toContain(['--bind', parent, parent].join('\n'))
        expect(text).toContain(['--ro-bind', input, input].join('\n'))
      }
    } else if (platform === 'darwin') {
      expect(handed.argv[2]).toContain(`(allow file-write* (subpath ${JSON.stringify(workspace)}))`)
      expect(handed.argv[2]).toContain(`(deny file-write* (subpath ${JSON.stringify(input)}))`)
      expect(handed.argv[2]).toContain(`(deny file-write-unlink (literal ${JSON.stringify(dirname(input))}))`)
    } else {
      expect(native.allows).toContain(workspace)
      expect(handed.argv).toContain('--protected-path')
      expect(handed.argv).toContain(input)
      if (effect !== 'create absent input') expect(native.denies).toContainEqual({ path: input, recursive: true })
      expect(native.denies).toContainEqual({ path: parent, recursive: false })
      expect(native.denies).not.toContainEqual({ path: workspace, recursive: true })
    }
  })
}
