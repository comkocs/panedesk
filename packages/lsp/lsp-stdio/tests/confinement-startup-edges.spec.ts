import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import SessionProjections from '@panedesk/dsh-session-projection'
import SandboxPolicy from '@panedesk/dsh-sandbox-policy'
import { SandboxProvider, type ConfinedArgv } from '@panedesk/dsh-sandbox'
import LocalSubprocess from '@panedesk/dsh-subprocess-local'
import LocalFileSystem from '@panedesk/dsh-fs-local'
import Lsp from '@panedesk/dsh-lsp'
import * as Stdio from '../src/index.ts'
import { expect, it, vi } from 'vitest'

class StartupSandbox extends SandboxProvider {
  prepare: (argv: readonly string[]) => Promise<ConfinedArgv> = async argv => ({
    argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [],
  })

  confine(argv: readonly string[]): Promise<ConfinedArgv> { return this.prepare(argv) }
}

it.each(['missing', 'changed', 'empty', 'product'] as const)('refuses %s confinement before publishing a server', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'lsp-admission-edges-'))
  vi.stubEnv('PANEDESK_HOME', root)
  const ctx = new Context()
  try {
    await writeFile(join(root, 'source.ts'), 'const value = 1\n')
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: root })
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    if (kind !== 'product') spawn.mockImplementation(() => { throw new Error('Unexpected server launch') })
    if (kind !== 'missing') {
      await ctx.plugin(StartupSandbox)
      const sandbox = ctx.sandbox as StartupSandbox
      sandbox.prepare = async (argv) => {
        if (kind === 'product') return {
          argv: [...argv], productSandbox: true, enforcement: 'full', denialSignatures: [], runnerFailureRules: [],
        }
        if (kind === 'changed') {
          const policy = ctx.sandboxPolicy.resolve({})
          vi.spyOn(ctx.sandboxPolicy, 'resolve').mockReturnValue({ ...policy, mode: 'danger-full-access' })
        }
        return { argv: [], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
      }
    }
    await ctx.plugin(Stdio, { servers: { synthetic: {
      command: process.execPath, args: [fileURLToPath(new URL('./fixture-server.ts', import.meta.url))],
      env: { LSP_FAKE_HOVER: JSON.stringify({ contents: 'confined' }) }, extensionToLanguage: { '.ts': 'typescript' },
    } } })
    const messages = {
      missing: 'requires a sandbox provider', changed: 'policy changed during startup', empty: 'empty command',
    }
    const pending = ctx.lsp.query({
      operation: 'hover', filePath: 'source.ts', position: { line: 0, character: 0 }, workspaceRoot: root,
    })
    if (kind === 'product') {
      expect(await pending).toMatchObject({ kind: 'hover', hover: { contents: 'confined' } })
      expect(spawn.mock.calls[0]?.[0].productSandbox).toBe(true)
    } else {
      await expect(pending).rejects.toThrow(messages[kind])
      expect(spawn).not.toHaveBeenCalled()
    }
  } finally {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
