/** Executable paths are argv elements, including Windows paths with spaces. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import LocalSubprocessRuntime from '@panedesk/dsh-subprocess-local'
import { LocalBashExecutor } from '../src/index.ts'

it.each(['bash', 'C:\\Program Files\\Git\\bin\\bash.exe'])('passes %s verbatim as the executable', async (bashPath) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => { throw new Error('test spawn') })
  await ctx.plugin(LocalBashExecutor, bashPath === 'bash' ? {} : { bashPath })
  const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'printf hello' }))
  await expect(execution.result()).rejects.toThrow('test spawn')
  expect(spawn.mock.calls[0]?.[0].argv).toEqual([bashPath, '-c', 'printf hello'])
})
