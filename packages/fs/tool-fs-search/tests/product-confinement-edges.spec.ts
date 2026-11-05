import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { provideWorkingDirectoryFixture } from '@panedesk/dsh-agent-loop-testkit'
import { ToolCallId } from '@panedesk/dsh-llm'
import ToolRuntime from '@panedesk/dsh-tools'
import SystemPrompt from '@panedesk/dsh-system-prompt'
import SessionProjections from '@panedesk/dsh-session-projection'
import SandboxPolicy from '@panedesk/dsh-sandbox-policy'
import { SandboxProvider, type ConfinedArgv } from '@panedesk/dsh-sandbox'
import LocalSubprocess from '@panedesk/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@panedesk/dsh-subprocess'
import * as Search from '../src/index.ts'
import { expect, it, vi } from 'vitest'

class ProductSandbox extends SandboxProvider {
  async confine(argv: readonly string[]): Promise<ConfinedArgv> {
    return { argv: [...argv], productSandbox: true, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

it('preserves product confinement when the search tool launches its command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'search-product-edges-'))
  vi.stubEnv('PANEDESK_HOME', root)
  const ctx = new Context()
  try {
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: root })
    await ctx.plugin(ProductSandbox)
    const handle: SubprocessHandle = {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 1, signal: null }), terminate: () => {}, waitForExit: async () => true,
    }
    await ctx.plugin(LocalSubprocess)
    const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((_spec: SubprocessSpawnSpec) => handle)
    await ctx.plugin(Search, { sampleOverCapGlobResults: true })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('product-search'), name: 'glob', arguments: { pattern: '*' },
    })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0].productSandbox).toBe(true)
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})
