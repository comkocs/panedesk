import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome } from '@panedesk/dsh-subprocess'
import { expect, it, vi } from 'vitest'
import { PythonPtcRuntime } from '../src/index.ts'
import { createRuntimeContext } from './setup.ts'

it('settles a decided completion after synchronous termination fails before the close deadline exists', async () => {
  const ctx = await createRuntimeContext()
  const streams = Array.from({ length: 4 }, () => new PassThrough())
  const [stdin, stdout, stderr, control] = streams
  if (stdin === undefined || stdout === undefined || stderr === undefined || control === undefined) throw new Error('Missing protocol streams')
  const exit = Promise.withResolvers<SubprocessOutcome>()
  const stopped = new Error('Synchronous termination failed')
  const terminate = vi.fn().mockImplementationOnce(() => { throw stopped })
  const waitForExit = vi.fn(async () => true)
  const handle: SubprocessHandle = {
    stdin, stdout, stderr, control, collected: {}, done: exit.promise, terminate, waitForExit,
  }
  const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(handle)
  const fiber = await ctx.plugin(PythonPtcRuntime)
  const runtime = ctx.ptcRuntime as PythonPtcRuntime
  try {
    const result = runtime.run(runtime.resolve({ program: 'return 7', bindings: [] }))
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledOnce() })
    expect(() => control.emit('data', Buffer.from('{"type":"done","value":7}\n'))).toThrow(stopped)
    expect(terminate).toHaveBeenCalledOnce()
    expect(waitForExit).not.toHaveBeenCalled()
    stdout.end()
    stderr.end()
    control.destroy()
    exit.resolve({ exitCode: 0, signal: null })
    expect((await result).value).toBe(7)
    await runtime['teardown']()
    expect(terminate).toHaveBeenCalledTimes(2)
    expect(waitForExit).toHaveBeenCalledOnce()
  } finally {
    spawn.mockRestore()
    for (const stream of streams) stream.destroy()
    await fiber.dispose()
  }
})
