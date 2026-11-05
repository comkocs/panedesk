import { Duplex, PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@panedesk/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@panedesk/dsh-subprocess'
import { expect, it, onTestFinished, vi } from 'vitest'
import { JsonChannel } from '../src/channel.ts'
import { mountRuntime } from './setup.ts'

async function fixture() {
  const ctx = new Context()
  const { runtime } = await mountRuntime(ctx, { executionMode: 'persistent-in-memory', graceMs: 25 })
  const control = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) { child.push(chunk); callback() },
  })
  const child = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) { control.push(chunk); callback() },
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const direct = Promise.withResolvers<SubprocessOutcome>()
  const terminate = vi.fn(() => { stdout.end(); stderr.end(); direct.resolve({ exitCode: 0, signal: null }) })
  const waitForExit = vi.fn(async () => true)
  const handle: SubprocessHandle = {
    stdin: undefined, stdout, stderr, control, collected: {}, done: direct.promise, terminate, waitForExit,
  }
  const writes = new Set<Promise<void>>()
  const booted = Promise.withResolvers<undefined>()
  let received: () => void = () => { booted.resolve(undefined) }
  const peer = new JsonChannel(child, 1024 * 1024, () => { received() }, () => {})
  const emit = (message: unknown): void => {
    const write = peer.send(message).finally(() => { writes.delete(write) })
    writes.add(write)
  }
  vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue(process.execPath)
  const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(handle)
  const owner = {}
  const start = (restricted = false) => {
    const pending = runtime.run(runtime.resolve({
      program: '1', bindings: [], stateOwner: owner,
      ...restricted ? { sandboxPolicy: { mode: 'read-only' as const, workspaceRoot: process.cwd() } } : {},
    }))
    queueMicrotask(() => { emit({ type: 'ready' }) })
    return pending
  }
  onTestFinished(async () => {
    peer.close()
    for (const stream of [control, child, stdout, stderr]) stream.destroy()
    direct.resolve({ exitCode: 0, signal: null })
    await Promise.allSettled(writes)
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
  })
  return {
    ctx, runtime, owner, control, stdout, stderr, direct, terminate, waitForExit, spawn, start, booted: booted.promise,
    receive: (callback: () => void) => { received = callback }, emit,
  }
}

it('carries product confinement and classifies a persistent worker denial', async () => {
  const h = await fixture()
  vi.spyOn(h.ctx.sandbox, 'confine').mockImplementation(async argv => ({
    argv: [...argv], productSandbox: true, enforcement: 'full',
    denialSignatures: ['permission denied'], runnerFailureRules: [],
  }))
  h.receive(() => { h.emit({ id: 1, payload: { type: 'done', error: { kind: 'exception', message: 'Permission denied' } } }) })
  const result = await h.start(true)
  expect(result.sandbox).toMatchObject({ mode: 'read-only', denied: true, enforcement: 'full' })
  expect(h.spawn.mock.calls[0]?.[0].productSandbox).toBe(true)
})

it.each(['deadline', 'rejected', 'released'] as const)('joins control EOF through %s observation', async (kind) => {
  const h = await fixture()
  const pending = h.start()
  await h.booted
  const observed = Promise.withResolvers<boolean>()
  if (kind === 'released') {
    h.terminate.mockImplementation(() => { h.stdout.end(); h.stderr.end() })
    h.waitForExit.mockImplementation(() => observed.promise)
  }
  h.control.push(null)
  await setImmediate()
  if (kind === 'rejected') {
    h.direct.reject(new Error('Process failed'))
  } else if (kind === 'released') {
    const release = h.runtime.release(h.owner)
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.terminate).toHaveBeenCalledOnce()
    } finally {
      observed.resolve(true)
      h.direct.resolve({ exitCode: 0, signal: null })
      await release
    }
  } else {
    await vi.waitFor(() => { expect(h.terminate).toHaveBeenCalled() })
  }
  const result = await pending
  expect(result.error?.kind).toBe(kind === 'released' ? 'abort' : 'worker-exit')
  if (kind === 'rejected') expect(result.error?.message).toContain('Process failed')
})
