/** Supervised failures retain committed identities and resume only after a complete successful round. */
import { afterEach, expect, it, vi } from 'vitest'
import { EngineError } from '../src/journal.ts'
import { EngineFailures } from '../src/failure.ts'
import { validateConfig } from '../src/index.ts'
import { auto, config, harness, projectId, trigger } from './fixtures.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it.each([
  ['drive', true], ['drive', false], ['notification', true], ['notification', false],
  ['callback', true], ['callback', false],
] as const)('contains %s failures with retryable=%s', async (site, retryable) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const h = await harness({ failureRecovery: { retryInitialMs: 2000 } })
  const error = retryable ? Object.assign(new Error('private exception text'), { code: 'ETIMEDOUT' })
    : new EngineError('state-conflict', 'private exception text')
  let injected = false
  const failOnce = () => { if (!injected) { injected = true; throw error } }
  const decisions: number[] = []
  try {
    if (site === 'notification') {
      h.ctx.on('seat/decision', (decision) => { decisions.push(decision.sequence); failOnce() })
      await auto(h.engine)
    } else {
      await auto(h.engine)
      await h.engine.accept(trigger())
      if (site === 'drive') vi.spyOn(h.seatProvider, 'resolve').mockImplementation(async (name) => {
        failOnce(); return h.definitions.get(name)!
      })
      else vi.spyOn(h.source, 'callback').mockImplementation(async (payload) => { h.callbacks.push(payload); failOnce() })
      await vi.advanceTimersByTimeAsync(1000)
      try { await h.engine.drive() } catch (caught) { expect(caught).toBe(error) }
    }
    const failed = await h.engine.nodeStatus()
    expect(failed).toMatchObject({ engine: 'unavailable', failure: {
      site: site === 'drive' ? 'scheduled-drive' : site === 'notification' ? 'decision-notification' : 'callback-delivery',
      code: retryable ? 'ETIMEDOUT' : 'state-conflict', retryable, attempts: 1,
    } })
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain('private exception text')
    await vi.advanceTimersByTimeAsync(1000)
    expect((await h.engine.nodeStatus()).engine).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(2000)
    await h.engine.drive()
    expect((await h.engine.nodeStatus()).engine).toBe(retryable ? 'running' : 'unavailable')
    if (retryable) {
      expect((await h.engine.nodeStatus()).failure).toBeUndefined()
      if (site === 'notification') expect(decisions).toEqual([1, 1])
      if (site === 'callback') {
        expect(h.callbacks).toHaveLength(2)
        expect(h.callbacks[0]).toEqual(h.callbacks[1])
        expect(h.creates).toHaveLength(1)
      }
    } else {
      expect(log).toHaveBeenCalledTimes(1)
      expect(String(log.mock.calls[0]?.[0])).toContain('stop-and-restart-after-repair')
    }
  } finally { await h.close() }
})

it('drains reentrant and concurrent decisions without awaiting its own listener', async () => {
  const h = await harness({ failureRecovery: { retryInitialMs: 2000 }, ownerObserveIntervalMs: 60000 })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const decisions: number[] = []
  // Cordis parallel awaits listener promises although the event declaration returns void.
  // oxlint-disable-next-line typescript/no-misused-promises
  h.ctx.on('seat/decision', async (decision) => {
    decisions.push(decision.sequence)
    if (decision.sequence !== 1) return
    entered.resolve(undefined)
    await release.promise
    expect((await h.engine.accept(trigger())).status).toBe('accepted')
  })
  try {
    const first = auto(h.engine)
    await entered.promise
    const concurrent = h.engine.setProjectMode({ projectId, mode: 'auto', expectedRevision: 1,
      operationId: 'policy-b' as Parameters<typeof h.engine.setProjectMode>[0]['operationId'] })
    release.resolve(undefined)
    await Promise.all([first, concurrent])
    expect(decisions).toEqual([1, 2, 3])
    expect((await h.engine.nodeStatus()).engine).toBe('running')
  } finally { release.resolve(undefined); await h.close() }
})

it('parks automatic execution but retains inbound admission and operator policy writes', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const h = await harness({ failureRecovery: { retryInitialMs: 2000 }, ownerObserveIntervalMs: 60000 })
  h.ctx.on('seat/decision', () => { throw new EngineError('state-conflict', 'notification conflict') })
  try {
    await auto(h.engine)
    expect((await h.engine.accept(trigger())).status).toBe('accepted')
    expect((await h.engine.setProjectMode({ projectId, mode: 'off', expectedRevision: 1,
      operationId: 'policy-off' as Parameters<typeof h.engine.setProjectMode>[0]['operationId'] })).status).toBe('saved')
    await h.engine.drive()
    expect(h.creates).toEqual([])
    expect((await h.engine.nodeStatus()).failure).toMatchObject({ retryable: false })
  } finally { await h.close() }
})

it('caps exponential retry at five minutes and alerts once strictly after ten minutes', () => {
  vi.useFakeTimers()
  const log = vi.fn(), failures = new EngineFailures(100000, log)
  const error = { code: 'ETIMEDOUT' }
  failures.record('scheduled-drive', error)
  const since = failures.snapshot()?.since
  expect(failures.runnable()).toBe(false)
  vi.advanceTimersByTime(100000)
  expect(failures.runnable()).toBe(true)
  failures.record('scheduled-drive', error)
  vi.advanceTimersByTime(200000)
  failures.record('scheduled-drive', error)
  expect(failures.snapshot()).toMatchObject({ since, attempts: 3 })
  vi.advanceTimersByTime(299999)
  expect(failures.runnable()).toBe(false)
  vi.advanceTimersByTime(1)
  expect(failures.runnable()).toBe(true)
  expect(log).toHaveBeenCalledTimes(3)
  vi.advanceTimersByTime(1)
  expect(log).toHaveBeenCalledTimes(4)
  expect(String(log.mock.calls[3]?.[0])).toContain('over ten minutes')
  vi.advanceTimersByTime(600000)
  expect(log).toHaveBeenCalledTimes(4)
  failures.succeeded(failures.generation())
  expect(failures.snapshot()).toBeUndefined()
  failures.close()
})

it('retains unknown and persistence failures despite later transient errors or successful rounds', () => {
  const failures = new EngineFailures(1, () => {})
  try {
    failures.record('callback-delivery', new EngineError('unavailable', 'private', { cause: { code: 'ETIMEDOUT' } }))
    failures.record('scheduled-drive', { code: 'ETIMEDOUT' })
    failures.succeeded(failures.generation())
    expect(failures.snapshot()).toMatchObject({ code: 'unavailable', retryable: false, attempts: 2 })
    expect(failures.runnable()).toBe(false)
  } finally { failures.close() }
  const unknown = new EngineFailures(1, () => {})
  try {
    unknown.record('scheduled-drive', new Error('private'))
    expect(unknown.snapshot()).toMatchObject({ code: 'unclassified-error', retryable: false })
  } finally { unknown.close() }
})

it('preserves the default latched status and validates explicit retry policy', () => {
  const failures = new EngineFailures(undefined, () => {})
  try {
    failures.record('scheduled-drive', { code: 'ETIMEDOUT' })
    failures.succeeded(failures.generation())
    expect(failures.snapshot()).toMatchObject({ retryable: true })
    expect(failures.runnable()).toBe(true)
  } finally { failures.close() }
  for (const retryInitialMs of [0, -1, 300001, 1.5]) {
    expect(() => validateConfig({ ...config, failureRecovery: { retryInitialMs } })).toThrow('Invalid engine failure retry delay')
  }
  expect(validateConfig({ ...config, failureRecovery: { retryInitialMs: 300000 } }).failureRecovery).toEqual({ retryInitialMs: 300000 })
})
