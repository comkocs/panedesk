/** Filesystem admission accepts providers without optional owner and host-path inventories. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import { expect, it, vi } from 'vitest'

it('uses empty optional inventories from a policy provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empty-policy-inventory-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
    const policy = { mode: 'workspace-write', workspaceRoot: root } as const
    const resolve = vi.spyOn(ctx.sandboxPolicy, 'resolve').mockReturnValue(policy)
    await ctx.plugin(SandboxedFileSystem, { cwd: root })
    const path = join(root, 'document')
    await writeFile(path, 'ordinary')
    const target = await ctx.fs.resolve(path)
    expect(await ctx.fs.readText(target, undefined, policy)).toBe('ordinary')
    expect((await ctx.fs.listDir(await ctx.fs.resolve(root), undefined, policy)).map(entry => entry.name)).toEqual(['document'])
    await ctx.fs.writeText(target, 'updated', undefined, undefined, policy)
    expect(await readFile(path, 'utf8')).toBe('updated')
    expect(resolve).toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
