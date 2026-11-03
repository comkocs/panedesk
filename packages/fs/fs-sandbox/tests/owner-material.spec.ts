/** Owner credential documents are unavailable through every filesystem read form. */
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import { afterEach, expect, it, vi } from 'vitest'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

it.each(['read-only', 'workspace-write'] as const)('denies owner material and aliases in %s', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'owner-material-'))
  directories.push(root)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  mkdirSync(join(home, 'private'))
  const document = join(home, 'private', '.credentials.yaml')
  writeFileSync(document, 'synthetic credential document', { mode: 0o600 })
  const symbolic = join(workspace, 'symbolic')
  const hard = join(workspace, 'hard')
  symlinkSync(document, symbolic)
  linkSync(document, hard)
  vi.stubEnv('PANEDESK_HOME', home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  for (const path of [document, symbolic, hard, `${home}/../home/private/.credentials.yaml`]) {
    const target = await ctx.fs.resolve(path)
    await expect(ctx.fs.readText(target)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(ctx.fs.readBytes(target, undefined, 1024)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(ctx.fs.readByteRange(target, { offset: 0, length: 32 })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(ctx.fs.streamText(target)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  }
  const ownerTarget = await ctx.fs.resolve(document)
  await expect(ctx.fs.stat(ownerTarget)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(await ctx.fs.readText(ownerTarget, undefined, { mode: 'danger-full-access', workspaceRoot: workspace }))
    .toBe('synthetic credential document')
  await expect(ctx.fs.readText(ownerTarget, undefined, { mode, workspaceRoot: workspace }))
    .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  const entries = await ctx.fs.listDir(await ctx.fs.resolve(home))
  expect(entries.map(entry => entry.name)).not.toContain('private')
  const ordinary = join(workspace, 'ordinary.txt')
  writeFileSync(ordinary, 'ordinary project content')
  expect(await ctx.fs.readText(await ctx.fs.resolve(ordinary))).toBe('ordinary project content')
})
