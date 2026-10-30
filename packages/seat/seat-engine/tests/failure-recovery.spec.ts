/** Supervised failures retain committed identities and resume only after a complete successful round. */
import { afterEach, expect, it, vi } from 'vitest'
import { EngineError } from '../src/journal.ts'
import { EngineFailures } from '../src/failure.ts'
import { validateConfig } from '../src/index.ts'
import { auto, config, harness, projectId, trigger } from './fixtures.ts'
import { join } from 'node:path'
import { withWriterLock, LedgerUnavailableError } from '@panedesk/dsh-session-ledger/src/lock.ts'

it('backs off only ledger lock acquisition timeouts and resumes the retained opening once', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const h = await harness({ failureRecovery: { retryInitialMs: 2000 } })
  const lock = join(h.home, 'writer.lock')
  const changed = vi.fn()
  h.ctx.on('seat/diagnostics-changed', changed)
  let failure: unknown
  try {
    await auto(h.engine)
    await h.engine.accept(trigger())
    await withWriterLock(lock, { lockTimeoutMs: 1000, lockRetryMs: 1 }, async () => {
      try {
        await withWriterLock(lock, { lockTimeoutMs: 1, lockRetryMs: 1 }, async () => {
          throw new Error('A contended writer must never enter its transaction')
        })
      } catch (error) { failure = new LedgerUnavailableError(error) }
    })
    expect(failure).toMatchObject({ code: 'LEDGER_UNAVAILABLE', lockTimeoutCode: 'LEDGER_LOCK_TIMEOUT' })
    const resolve = h.seatProvider.resolve.bind(h.seatProvider)
    vi.spyOn(h.seatProvider, 'resolve').mockRejectedValueOnce(failure).mockImplementation(resolve)
    await vi.advanceTimersByTimeAsync(1000)
    try { await h.engine.drive() } catch (error) { expect(error).toBe(failure) }
    expect((await h.engine.nodeStatus()).failure).toMatchObject({ code: 'LEDGER_LOCK_TIMEOUT', retryable: true })
    expect(changed).toHaveBeenCalled()
    changed.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.creates).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2000)
    await h.engine.drive()
    expect((await h.engine.nodeStatus()).failure).toBeUndefined()
    expect(changed).toHaveBeenCalled()
    await h.engine.drive()
    expect(h.creates).toHaveLength(1)
    expect([...h.engine.journal.projection.opens.values()]).toHaveLength(1)
  } finally { await h.close() }
})

it('bounds owner-release retries and reports exhaustion without an endless retry loop', () => {
  vi.useFakeTimers()
  const log = vi.fn(), changed = vi.fn()
  const failures = new EngineFailures(1000, log, changed, 3)
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      failures.record('owner-release', new EngineError('unavailable', 'Release budget exceeded'),
        'owner-release-budget-exceeded')
      expect(failures.snapshot()).toMatchObject({ code: 'owner-release-budget-exceeded',
        retryable: attempt < 3, attempts: attempt })
      expect(failures.runnable()).toBe(false)
      vi.advanceTimersByTime(1000 * 2 ** (attempt - 1) - 1)
      expect(failures.runnable()).toBe(false)
      vi.advanceTimersByTime(1)
      expect(failures.runnable()).toBe(attempt < 3)
    }
    vi.advanceTimersByTime(600000)
    expect(failures.runnable()).toBe(false)
    expect(changed).toHaveBeenCalledTimes(3)
    expect(String(log.mock.calls[2]?.[0])).toContain('stop-and-restart-after-repair')
  } finally { failures.close() }
})

it('does not retry ledger errors raised after acquiring the writer lock', async () => {
  const failures = new EngineFailures(1, () => {})
  const h = await harness()
  const writeFailure = Object.assign(new Error('write failed'), { code: 'EAGAIN' })
  try {
    try {
      await withWriterLock(join(h.home, 'writer.lock'), { lockTimeoutMs: 1000, lockRetryMs: 1 }, async () => { throw writeFailure })
    } catch (error) {
      expect(error).toBe(writeFailure)
      expect(error).not.toHaveProperty('lockTimeoutCode')
      failures.record('scheduled-drive', new LedgerUnavailableError(error))
    }
    expect(failures.snapshot()).toMatchObject({ code: 'unclassified-error', retryable: false })
    expect(failures.runnable()).toBe(false)
  } finally { failures.close(); await h.close() }
})

it('invalidates owner diagnostics when an unregistered failure stops the real engine', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const h = await harness({ failureRecovery: { retryInitialMs: 2000 } })
  const changed = vi.fn()
  h.ctx.on('seat/diagnostics-changed', changed)
  try {
    await auto(h.engine)
    await h.engine.accept(trigger())
    changed.mockClear()
    vi.spyOn(h.seatProvider, 'resolve').mockRejectedValue(Object.assign(new Error('Not public'), { code: 'test/unregistered' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect((await h.engine.nodeStatus()).failure).toMatchObject({ code: 'unclassified-error', retryable: false })
    expect(changed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(h.creates).toHaveLength(0)
    expect((await h.engine.nodeStatus()).failure?.retryable).toBe(false)
  } finally { await h.close() }
})

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

it.each([
  [new Error('private exception text'), [{ constructor: 'Error', name: 'Error' }]],
  [new Error('private exception text', { cause: Object.assign(new TypeError('private cause'), { code: 'ETIMEDOUT' }) }),
    [{ constructor: 'Error', name: 'Error' }, { constructor: 'TypeError', name: 'TypeError', code: 'ETIMEDOUT' }]],
  [new AggregateError([new Error('private aggregate member'), Object.assign(new Error('private code'), { code: 'CUSTOM_FAILURE' })]),
    [{ constructor: 'AggregateError', name: 'AggregateError' }, { constructor: 'Error', name: 'Error' },
      { constructor: 'Error', name: 'Error', code: 'CUSTOM_FAILURE' }]],
])('logs bounded exception identifiers without changing unknown classification: %s', (error, identifiers) => {
  const log = vi.fn(), failures = new EngineFailures(1, log)
  try {
    failures.record('callback-delivery', error)
    expect(failures.snapshot()).toMatchObject({ code: 'unclassified-error', retryable: false })
    const line = String(log.mock.calls[0]?.[0])
    expect(line).toContain(`"exception":${JSON.stringify(identifiers)}`)
    expect(line).not.toContain('private')
    expect(failures.snapshot()).not.toHaveProperty('exception')
  } finally { failures.close() }
})

it('bounds exception traversal and excludes unsafe identifiers and exception text', () => {
  const log = vi.fn(), failures = new EngineFailures(1, log)
  const secret = `sk-${'x'.repeat(48)}`
  const message = `https://example.invalid/private?key=${secret}`
  const nested = Object.assign(new Error(message), { code: 'ECONNRESET' })
  let error: Error = nested
  for (let depth = 0; depth < 8; depth++) error = new Error(message, { cause: error })
  const unsafe = Object.assign(new Error(message), { name: message, code: secret })
  try {
    failures.record('callback-delivery', new AggregateError([error, unsafe, ...Array.from({ length: 40 }, () => nested)], message))
    const line = String(log.mock.calls[0]?.[0])
    expect(line).toContain('"exception":')
    expect(line).not.toContain(message)
    expect(line).not.toContain(secret)
    expect(line).not.toContain('https')
    expect(line).not.toContain('stack')
    expect(line.length).toBeLessThan(4096)
    expect(line.match(/"constructor"/g)?.length).toBeLessThanOrEqual(16)
  } finally { failures.close() }
})

it('keeps an unclassified callback stopped through the watchdog and requires repair before restart recovery', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const h = await harness({ failureRecovery: { retryInitialMs: 2000 } })
  let engine = h.engine, broken = true
  vi.spyOn(h.source, 'callback').mockImplementation(async (payload) => {
    if (broken) throw new Error('private callback failure')
    h.callbacks.push(payload)
  })
  try {
    await auto(engine); await engine.accept(trigger())
    await vi.advanceTimersByTimeAsync(1000); await engine.drive()
    expect((await engine.nodeStatus()).failure).toMatchObject({ code: 'unclassified-error', retryable: false })
    await vi.advanceTimersByTimeAsync(600001)
    expect(log.mock.calls.some(([line]) => String(line).includes('over ten minutes'))).toBe(true)
    await engine.shutdown(); engine = await h.start()
    await vi.advanceTimersByTimeAsync(1000); await engine.drive()
    expect((await engine.nodeStatus()).engine).toBe('unavailable')
    broken = false
    await engine.drive()
    expect((await engine.nodeStatus()).engine).toBe('unavailable')
    await engine.shutdown(); engine = await h.start()
    await vi.advanceTimersByTimeAsync(1000); await engine.drive()
    expect((await engine.nodeStatus()).engine).toBe('running')
    expect((await engine.nodeStatus()).failure).toBeUndefined()
    expect(h.callbacks).toHaveLength(1)
  } finally { await h.close() }
})

it.each(['issuer', 'peer-query', 'local-query'] as const)('retries unavailable callbacks before effects at %s', (phase) => {
  vi.useFakeTimers()
  const log = vi.fn(), failures = new EngineFailures(2000, log)
  try {
    failures.record('callback-delivery', { code: 'unavailable' }, undefined,
      { phase, effectState: 'none', retryable: true })
    expect(failures.snapshot()).toMatchObject({ code: 'unavailable', retryable: true, attempts: 1 })
    expect(failures.runnable()).toBe(false)
    vi.advanceTimersByTime(1999)
    expect(failures.runnable()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(failures.runnable()).toBe(true)
    expect(String(log.mock.calls[0]?.[0])).toContain(`"phase":"${phase}"`)
    failures.succeeded(failures.generation())
    expect(failures.snapshot()).toBeUndefined()
  } finally { failures.close() }
})

it.each(['partial', 'committed', 'unknown'] as const)('does not retry unavailable callbacks with %s effects', (effectState) => {
  vi.useFakeTimers()
  const failures = new EngineFailures(2000, () => {})
  try {
    failures.record('callback-delivery', { code: 'unavailable' }, undefined,
      { phase: 'peer-dispatch', effectState, retryable: true })
    expect(failures.snapshot()).toMatchObject({ code: 'unavailable', retryable: false })
    vi.advanceTimersByTime(600001)
    failures.succeeded(failures.generation())
    expect(failures.runnable()).toBe(false)
  } finally { failures.close() }
})

it('does not let callback retry hints override conflicting or unknown evidence', () => {
  for (const code of ['state-conflict', 'callback-protocol-error', 'unregistered-callback']) {
    const failures = new EngineFailures(2000, () => {})
    try {
      failures.record('callback-delivery', { code }, undefined,
        { phase: 'peer-query', effectState: 'none', retryable: true })
      expect(failures.snapshot()).toMatchObject({ retryable: false })
      expect(failures.runnable()).toBe(false)
    } finally { failures.close() }
  }
})

it('validates the configured owner-release attempt bound', () => {
  for (const ownerReleaseMaxAttempts of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    expect(() => validateConfig({ ...config, failureRecovery: { retryInitialMs: 1000, ownerReleaseMaxAttempts } }))
      .toThrow('Invalid owner release retry limit')
  }
  expect(validateConfig({ ...config, failureRecovery: { retryInitialMs: 1000, ownerReleaseMaxAttempts: 3 } })
    .failureRecovery).toMatchObject({ ownerReleaseMaxAttempts: 3 })
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
