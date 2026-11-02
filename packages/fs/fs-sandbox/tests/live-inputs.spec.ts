/** Live configuration registrations and missing aliases remain protected at write admission. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Timer from '@panedesk/cordis-plugin-timer'
import Hmr from '@panedesk/dsh-hmr'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import { expect, it, onTestFinished, vi } from 'vitest'

async function fixture(implicit: boolean) {
  const parent = mkdtempSync(join(tmpdir(), 'live-inputs-'))
  const root = join(parent, 'workspace')
  mkdirSync(root)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(parent, { recursive: true, force: true })
  })
  vi.stubEnv('PANEDESK_HOME', join(parent, 'home'))
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  await ctx.plugin(SessionProjectionRegistry)
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await ctx.plugin(SandboxPolicyService, { workspaceRoot: root, ...implicit ? {} : { mode: 'workspace-write' } })
  platform.mockRestore()
  if (implicit) await ctx.sandboxPolicy.workspaceAccess.authorize(root, 'first-confirmation')
  await ctx.plugin(SandboxedFileSystem, { cwd: root })
  return { ctx, root }
}

for (const implicit of [false, true]) {
  it(`protects active configuration registrations until disposal (implicit: ${implicit})`, async () => {
    const { ctx, root } = await fixture(implicit)
    ctx.baseUrl = pathToFileURL(root + '/').href
    await ctx.plugin(Loader)
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    const filename = join(root, 'runtime.patch.yml')
    writeFileSync(filename, '[]\n')
    const refresh = vi.fn(async () => {})
    const dispose = await ctx.hmr.watchConfig(filename, refresh)
    refresh.mockClear()
    const target = await ctx.fs.resolve(filename)
    await expect(ctx.fs.writeText(target, '- name: ./model-plugin.mjs\n')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(readFileSync(filename, 'utf8')).toBe('[]\n')
    expect(ctx.sandboxPolicy.resolve().protectedPaths).toContain(filename)
    await dispose()
    expect(ctx.sandboxPolicy.resolve().protectedPaths ?? []).not.toContain(filename)
    await ctx.fs.writeText(target, '[] # released\n')
    expect(readFileSync(filename, 'utf8')).toBe('[] # released\n')
  })

  for (const spelling of ['protected-alias', 'target-alias', 'both-aliases'] as const) {
    it(`refuses a missing configuration through ${spelling} (implicit: ${implicit})`, async () => {
      const { ctx, root } = await fixture(implicit)
      const real = join(root, 'actual')
      const alias = join(root, 'alias')
      mkdirSync(real)
      symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const protectedPath = join(spelling === 'target-alias' ? real : alias, 'later', 'config.yml')
      const targetPath = join(spelling === 'protected-alias' ? real : alias, 'later', 'config.yml')
      ctx.provide('profileContext', {
        name: 'active', dir: join(root, 'profile'), patchPath: join(root, 'profile', 'cordis.patch.yml'),
        home: join(root, 'home'), cwd: root, installAnchor: join(root, 'installation', 'package.json'),
        startedBundles: [], overlays: [], overlayPaths: [protectedPath], telemetryDisabledEnv: undefined,
      })
      await expect(ctx.fs.writeText(await ctx.fs.resolve(targetPath), '- name: ./model-plugin.mjs\n'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    })
  }
}
