/** Managed-range observation must gate Python runtime disposal. */
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import type { SubprocessHandle } from '@panedesk/dsh-subprocess'
import { PythonPtcRuntime } from '../src/index.ts'
import { createRuntimeContext } from './setup.ts'

it('retains a missing-stream launch until its managed range exits', async () => {
  const ctx = await createRuntimeContext()
  const exited = Promise.withResolvers<boolean>()
  const terminate = vi.fn()
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: Promise.resolve({ exitCode: 1, signal: null }), terminate, waitForExit: () => exited.promise,
  }
  vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(handle)
  const fiber = await ctx.plugin(PythonPtcRuntime)
  const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program: 'return 1', bindings: [] }))
  expect(result.error?.kind).toBe('worker-exit')
  expect(terminate).toHaveBeenCalledOnce()
  let disposed = false
  const disposal = fiber.dispose().then(() => { disposed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(disposed).toBe(false)
  exited.resolve(true)
  await disposal
  expect(disposed).toBe(true)
})

it('reports failed managed-range observation instead of claiming quiescence', async () => {
  const ctx = await createRuntimeContext()
  const streams = Array.from({ length: 4 }, () => new PassThrough())
  const [stdin, stdout, stderr, control] = streams
  const handle: SubprocessHandle = {
    stdin, stdout, stderr, control, collected: {},
    done: Promise.resolve({ exitCode: 1, signal: null }),
    terminate() { for (const stream of streams) stream.destroy() },
    async waitForExit() { throw new Error('range observation unavailable') },
  }
  vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(handle)
  const fiber = await ctx.plugin(PythonPtcRuntime)
  const runtime = ctx.ptcRuntime as PythonPtcRuntime
  setImmediate(() => { stdout?.end(); stderr?.end(); control?.end() })
  const result = await runtime.run(runtime.resolve({ program: 'return 1', bindings: [] }))
  expect(result.error?.kind).toBe('worker-exit')
  await expect(runtime['teardown']()).rejects.toThrow('range observation unavailable')
  await fiber.dispose()
})
