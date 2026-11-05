import { Context } from '@panedesk/cordis'
import { PwshLocalExecutor } from '@panedesk/dsh-pwsh-local'
import LocalSubprocessRuntime from '@panedesk/dsh-subprocess-local'
import type { ShellExecSpec } from '@panedesk/dsh-shell'
import { expect, it } from 'vitest'

class PreparedPowerShell extends PwshLocalExecutor {
  runPrepared(spec: ShellExecSpec) {
    return this.executeArgv(spec, async () => [process.execPath, '-e', 'process.stdout.write("prepared")'])
  }
}

it('executes an asynchronously prepared literal argv without confinement metadata', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(PreparedPowerShell, { graceMs: 200 })
    const executor = ctx.shell as PreparedPowerShell
    const execution = await executor.runPrepared(executor.resolve({ command: 'unused' }))
    const result = await execution.result()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('prepared')
  } finally {
    await ctx.fiber.dispose()
  }
})
