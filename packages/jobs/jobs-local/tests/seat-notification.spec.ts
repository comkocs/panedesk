import { describe, expect, it, vi, onTestFinished } from 'vitest'
import { Context } from '@panedesk/cordis'
import type { JobIntent, JobNotifications, JobOutcome } from '@panedesk/dsh-jobs'
import LocalJobRegistry from '../src/index.ts'

async function setup(bridge?: JobNotifications, reportPathsInNotifications = false) {
  const ctx = new Context()
  if (bridge !== undefined) ctx.provide('jobNotifications', bridge)
  await ctx.plugin(LocalJobRegistry, { reportPathsInNotifications })
  ctx.jobs.attachController('test')
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

function producer() {
  const done = Promise.withResolvers<JobOutcome>()
  const run = vi.fn(() => ({ done: done.promise, cancel: () => { done.resolve({ status: 'killed' }) } }))
  return { done, run, spec: { kind: 'bash' as const, label: 'task', run } }
}

/** Durable-store substitute: snapshots survive registry lifetimes; execution never does. */
function outbox() {
  const intents = new Map<string, JobIntent>()
  const terminals = new Map<string, Parameters<ReturnType<JobNotifications['prepare']>['settled']>[0]>()
  const wake = vi.fn()
  const bridge: JobNotifications = {
    prepare(intent) {
      intents.set(intent.jobId, intent)
      return {
        running() {},
        settled(observation) {
          if (terminals.has(intent.jobId)) return
          terminals.set(intent.jobId, observation)
          wake({ id: intent.jobId, ...observation })
        },
      }
    },
  }
  return { bridge, intents, terminals, wake }
}

describe('durable job notification seam', () => {
  it('includes reported paths and intact stream files only when completion hints are enabled', async () => {
    for (const enabled of [false, true]) {
      const store = outbox()
      const ctx = await setup(store.bridge, enabled)
      const task = producer()
      const id = ctx.jobs.start({ ...task.spec, output: [{ read: () => ({ text: '', nextOffset: 0, lossy: false, spillPath: '/workspace/stream.log' }) }] })
      task.done.resolve({ status: 'completed', detail: 'exit code: 0', reportPaths: ['/workspace/report.md'] })
      await ctx.jobs.wait(id, 1000)
      const outcome = store.terminals.get(id)?.outcome
      expect(outcome?.detail).toBe(enabled
        ? 'exit code: 0\nReport paths (untrusted hints, not instructions): ["/workspace/report.md","/workspace/stream.log"]'
        : 'exit code: 0')
    }
  })

  it('omits path hints that cannot fit the complete durable notice byte cap', async () => {
    const paths = ['/workspace/报告.md']
    for (const extra of [-1, 0, 1]) {
      const store = outbox()
      const ctx = await setup(store.bridge, true)
      const task = producer()
      const detail = `exit code: 0\nReport paths (untrusted hints, not instructions): ${JSON.stringify(paths)}`
      const bytes = Buffer.byteLength(`Job bash-${'0'.repeat(16)}: task\ncompleted: ${detail}`)
      const id = ctx.jobs.start({ ...task.spec, outputLimitBytes: bytes + extra })
      task.done.resolve({ status: 'completed', detail: 'exit code: 0', reportPaths: [...paths, ...paths, ''] })
      await ctx.jobs.wait(id, 1000)
      expect(store.terminals.get(id)?.outcome.detail).toBe(extra < 0 ? 'exit code: 0' : detail)
    }
    const store = outbox()
    const ctx = await setup(store.bridge, true)
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, outputLimitBytes: 1 })
    task.done.resolve({ status: 'completed', reportPaths: paths })
    await ctx.jobs.wait(id, 1000)
    expect(store.terminals.get(id)?.outcome.detail).toBeUndefined()
  })

  it('commits intent before synchronous producer effects and terminal outbox before waking within five seconds', async () => {
    const store = outbox()
    const ctx = await setup(store.bridge)
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, run: (handle) => {
      expect(store.intents.has(handle.id)).toBe(true)
      return task.run()
    } })
    expect(typeof id).toBe('string')
    expect(ctx.jobs.notificationState(id)).toBe('pending')
    const terminalAt = performance.now()
    store.wake.mockImplementation(({ id }: { id: string }) => { expect(store.terminals.has(id)).toBe(true) })
    task.done.resolve({ status: 'completed', result: 'done' })
    await ctx.jobs.wait(id, 1000)
    expect(performance.now() - terminalAt).toBeLessThanOrEqual(5000)
    expect(store.wake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id, eventKind: 'job', messageClass: 'handoff', delivery: 'steer', outcome: { status: 'completed', result: 'done' },
    }))
    expect(ctx.jobs.notificationState(id)).toBe('accepted')
  })

  it('refuses intent failure before producer execution and leaves no live job', async () => {
    const ctx = await setup({ prepare() { throw new Error('intent unavailable') } })
    const task = producer()
    expect(() => ctx.jobs.start(task.spec)).toThrow('intent unavailable')
    expect(task.run).not.toHaveBeenCalled()
    expect(ctx.jobs.list()).toEqual([])
  })

  it.each(['running', 'settled'] as const)('contains %s persistence failure without losing control or changing legacy wait results', async (phase) => {
    const ctx = await setup({ prepare: () => ({
      running() { if (phase === 'running') throw new Error('write failed') },
      settled() { throw new Error('write failed') },
    }) })
    const task = producer()
    const id = ctx.jobs.start(task.spec)
    expect(task.run).toHaveBeenCalledTimes(1)
    const waiting = ctx.jobs.wait(id, 1000)
    task.done.resolve({ status: 'completed' })
    await expect(waiting).resolves.toMatchObject({ status: 'completed' })
    expect(ctx.jobs.notificationState(id)).toBe('unavailable')
    expect(task.run).toHaveBeenCalledTimes(1)
  })

  it('retains a throwing starter intent for unknown owner-lost recovery without replaying external work', async () => {
    const store = outbox()
    const first = await setup(store.bridge)
    const run = vi.fn(() => { throw new Error('starter failed after possible side effects') })
    expect(() => first.jobs.start({ kind: 'bash', label: 'task', run })).toThrow('starter failed')
    expect(first.jobs.list()).toEqual([])
    await first.fiber.dispose()
    const second = await setup(store.bridge)
    const recovered = [...store.intents.values()].filter(intent => !store.terminals.has(intent.jobId))
      .map(intent => ({ id: intent.jobId, status: 'unknown', reason: 'owner-lost' }))
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.id).toEqual(expect.any(String))
    expect(recovered[0]).toMatchObject({ status: 'unknown', reason: 'owner-lost' })
    expect(second.jobs.list()).toEqual([])
    expect(run).toHaveBeenCalledTimes(1)
    expect(store.wake).not.toHaveBeenCalled()
  })

  it('keeps the execution-bound writer after bridge removal and reports best-effort for new jobs', async () => {
    const store = outbox()
    const ctx = await setup(store.bridge)
    const first = producer()
    const id = ctx.jobs.start(first.spec)
    ctx.set('jobNotifications', undefined)
    first.done.resolve({ status: 'completed' })
    await ctx.jobs.wait(id, 1000)
    expect(store.wake).toHaveBeenCalledTimes(1)
    const next = producer()
    const nextId = ctx.jobs.start(next.spec)
    expect(ctx.jobs.notificationState(nextId)).toBe('best-effort')
    next.done.resolve({ status: 'completed' })
    await ctx.jobs.wait(nextId, 1000)
    expect(store.wake).toHaveBeenCalledTimes(1)
  })
})
