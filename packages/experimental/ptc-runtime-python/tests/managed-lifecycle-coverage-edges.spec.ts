import { PassThrough } from 'node:stream'
import type { SubprocessHandle } from '@panedesk/dsh-subprocess'
import { expect, it, vi } from 'vitest'
import { PythonPtcRuntime } from '../src/index.ts'
import { createRuntimeContext } from './setup.ts'

it.each([false, true])('reports missing-stream observation refusal and failure: %s', async (reject) => {
  const ctx = await createRuntimeContext()
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: reject ? Promise.reject(new Error('Exit failed')) : Promise.resolve({ exitCode: 1, signal: null }),
    terminate: () => {},
    waitForExit: async () => {
      if (reject) throw new Error('Observer failed')
      return false
    },
  }
  vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(handle)
  const fiber = await ctx.plugin(PythonPtcRuntime)
  const runtime = ctx.ptcRuntime as PythonPtcRuntime
  try {
    const result = await runtime.run(runtime.resolve({ program: 'return 1', bindings: [] }))
    expect(result.error?.message).toContain('without four protocol streams')
    await expect(runtime['teardown']()).rejects.toThrow(reject ? 'Observer failed' : 'ended before quiescence')
  } finally {
    await fiber.dispose()
  }
})

it.each([false, true])('joins a prematurely ended worker with destroyed output: %s', async (destroyed) => {
  const ctx = await createRuntimeContext()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const control = new PassThrough()
  const streams = [stdin, stdout, stderr, control]
  if (destroyed) stdout.destroy()
  const handle: SubprocessHandle = {
    stdin, stdout, stderr, control, collected: {},
    done: Promise.resolve({ exitCode: 1, signal: null }),
    terminate: () => { for (const stream of streams) stream.destroy() },
    waitForExit: async () => destroyed,
  }
  vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(handle)
  const fiber = await ctx.plugin(PythonPtcRuntime)
  const runtime = ctx.ptcRuntime as PythonPtcRuntime
  setImmediate(() => { stdout.end(); stderr.end(); control.end() })
  try {
    const result = await runtime.run(runtime.resolve({ program: 'return 1', bindings: [] }))
    expect(result.error?.kind).toBe('worker-exit')
    if (destroyed) await runtime['teardown']()
    else await expect(runtime['teardown']()).rejects.toThrow('ended before quiescence')
  } finally {
    for (const stream of streams) stream.destroy()
    await fiber.dispose()
  }
})
