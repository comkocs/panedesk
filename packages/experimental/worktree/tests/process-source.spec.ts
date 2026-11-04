import { describe, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import SandboxProvider from '@panedesk/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@panedesk/dsh-sandbox'
import LocalSubprocessRuntime from '@panedesk/dsh-subprocess-local'
import { runCommand } from '../src/process.ts'

class MarkedSandbox extends SandboxProvider {
  async confine(argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', productSandbox: true, denialSignatures: [], runnerFailureRules: [] }
  }
}

describe('worktree process source identity', () => {
  it('preserves explicit confinement identity and omits it for full access', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(LocalSubprocessRuntime).await()
      await ctx.plugin(MarkedSandbox).await()
      vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue('/fixture/program')
      const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => ({
        stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {}, waitForExit: async () => true,
      }))
      for (const mode of ['read-only', 'danger-full-access'] as const) {
        await runCommand(ctx, { timeoutMs: 1000, graceMs: 100, maxOutputBytes: 100 },
          { mode, workspaceRoot: '/fixture' }, '/fixture', ['program'], new AbortController().signal)
      }
      expect(spawn.mock.calls.map(([spec]) => spec.productSandbox)).toEqual([true, undefined])
      expect(spawn.mock.calls.map(([spec]) => spec.argv)).toEqual([['/fixture/program'], ['/fixture/program']])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
