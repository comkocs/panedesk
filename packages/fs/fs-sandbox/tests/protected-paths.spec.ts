/** Loaded host inputs stay immutable even inside an otherwise writable workspace. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import type {} from '@panedesk/dsh-app-boot'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function fixture(implicit: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'protected-host-'))
  directories.push(root)
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'active')
  mkdirSync(profile, { recursive: true })
  vi.stubEnv('PANEDESK_HOME', home)
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await ctx.plugin(SandboxPolicyService, { workspaceRoot: root, ...implicit ? {} : { mode: 'workspace-write' } })
  platform.mockRestore()
  if (implicit) await ctx.sandboxPolicy.workspaceAccess.authorize(root, 'first-confirmation')
  ctx.provide('profileContext', {
    name: 'active', dir: profile, patchPath: join(profile, 'cordis.patch.yml'), home,
    cwd: root, installAnchor: join(root, 'installation', 'package.json'),
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  await ctx.plugin(SandboxedFileSystem, { cwd: root })
  return { ctx, root, home, profile }
}

describe.each([false, true])('loaded host paths, implicit Windows default: %s', (implicit) => {
  for (const location of ['profile patch', 'bundle manifest', 'plugin source', 'home patch']) {
    for (const operation of ['write', 'edit']) {
      it(`refuses ${operation} of ${location} without changing executable inputs`, async () => {
        const { ctx, home, profile } = await fixture(implicit)
        const path = location === 'profile patch' ? join(profile, 'cordis.patch.yml')
          : location === 'bundle manifest' ? join(profile, 'package.json')
            : location === 'plugin source' ? join(profile, 'node_modules', 'model-plugin', 'index.js')
              : join(home, 'cordis.patch.yml')
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, 'original')
        const target = await ctx.fs.resolve(path)
        const change = operation === 'write' ? ctx.fs.writeText(target, 'export function apply() {}')
          : ctx.fs.editText(target, { oldString: 'original', newString: 'export function apply() {}', replaceAll: false })
        await expect(change).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
        expect(readFileSync(path, 'utf8')).toBe('original')
      })
    }
  }

  it('allows a plugin development workspace and an unrelated source clone', async () => {
    const { ctx, root } = await fixture(implicit)
    for (const project of ['plugin-development', 'panedesk-clone']) {
      const directory = join(root, project)
      mkdirSync(directory)
      for (const filename of ['package.json', 'cordis.patch.yml', 'index.ts']) {
        const path = join(directory, filename)
        await ctx.fs.writeText(await ctx.fs.resolve(path), 'independent project')
        expect(readFileSync(path, 'utf8')).toBe('independent project')
      }
    }
  })

  it('refuses preauthorization of a root containing live profile inputs', async () => {
    const { ctx, root } = await fixture(implicit)
    await expect(ctx.sandboxPolicy.workspaceAccess.authorize(root, 'settings-preauthorization'))
      .rejects.toThrow('protected host path')
  })
})
