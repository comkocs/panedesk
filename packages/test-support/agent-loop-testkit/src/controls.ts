/** Deterministic test-owned gates, clocks, watch delivery, and write failures. */

/** A one-shot checkpoint; callers own release and must drain pending work before teardown. */
export interface TestGate {
  /** Resolves when the checkpoint is first entered. */
  readonly reached: Promise<void>
  /** Mark entry and wait for release, or reject on cancellation. */
  wait(signal?: AbortSignal): Promise<void>
  /** Release current and future entrants. */
  release(): void
}

/**
 * Create an explicit one-shot checkpoint without timers or global state.
 * @returns a checkpoint owned by one test scenario.
 */
export function createTestGate(): TestGate {
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  return {
    reached: reached.promise,
    async wait(signal) {
      reached.resolve()
      signal?.throwIfAborted()
      if (signal === undefined) return released.promise
      const aborted = Promise.withResolvers<never>()
      const stop = (): void => { aborted.reject(signal.reason) }
      signal.addEventListener('abort', stop, { once: true })
      try {
        await Promise.race([released.promise, aborted.promise])
      } finally {
        signal.removeEventListener('abort', stop)
      }
    },
    release() { released.resolve() },
  }
}

/** Independently controlled wall and monotonic milliseconds; no process globals are patched. */
export interface TestClocks {
  /** Read the wall timestamp used for persisted facts. */
  wallNow(): number
  /** Read elapsed monotonic time. */
  monotonicNow(): number
  /** Jump only the wall clock, including backwards. */
  setWall(milliseconds: number): void
  /** Advance elapsed time and wall time by a non-negative duration. */
  advance(milliseconds: number): void
}

/**
 * Create independent injectable clock functions.
 * @param wall - initial wall-clock milliseconds.
 * @param monotonic - initial monotonic milliseconds.
 * @returns mutable clocks without timers or global Date changes.
 */
export function createTestClocks(wall: number, monotonic: number): TestClocks {
  if (!Number.isFinite(wall) || !Number.isFinite(monotonic)) throw new Error('clock values must be finite')
  return {
    wallNow: () => wall,
    monotonicNow: () => monotonic,
    setWall(value) {
      if (!Number.isFinite(value)) throw new Error('wall clock must be finite')
      wall = value
    },
    advance(value) {
      if (!Number.isFinite(value) || value < 0) throw new Error('clock advance must be non-negative and finite')
      wall += value
      monotonic += value
    },
  }
}

/** Test-owned watch delivery switch; disabled notifications are dropped, not buffered. */
export interface WatchControl {
  /** Drop notifications until enabled again. */
  disable(): void
  /** Resume notification delivery. */
  enable(): void
  /** Permanently remove the underlying watch; idempotent. */
  close(): void
}

/**
 * Wrap a real watch registration without changing scanner or mailbox behavior.
 * @param subscribe - caller-owned real watch installer returning its disposer.
 * @param notify - recipient of enabled watch notifications.
 * @returns a delivery switch and underlying resource disposer.
 */
export function createWatchControl(subscribe: (notify: () => void) => () => void, notify: () => void): WatchControl {
  let enabled = true
  let closed = false
  const dispose = subscribe(() => { if (enabled && !closed) notify() })
  return {
    disable() { enabled = false },
    enable() { if (!closed) enabled = true },
    close() {
      if (closed) return
      closed = true
      dispose()
    },
  }
}

/** A one-shot failure injector placed immediately before a real write operation. */
export interface WriteFault {
  /** Schedule an error after the specified number of successful write opportunities. */
  failAfter(successes: number, code: 'ENOSPC' | 'EIO' | 'EACCES'): void
  /** Execute the real operation, or reject before invoking it at the armed opportunity. */
  run<T>(write: () => Promise<T>): Promise<T>
}

/**
 * Create an opt-in write fault; unarmed calls always execute the real operation.
 * @returns one scenario-local failure controller.
 */
export function createWriteFault(): WriteFault {
  let armed: { remaining: number; code: string } | undefined
  return {
    failAfter(successes, code) {
      if (!Number.isSafeInteger(successes) || successes < 0) throw new Error('write count must be a non-negative safe integer')
      armed = { remaining: successes, code }
    },
    async run(write) {
      if (armed !== undefined) {
        if (armed.remaining === 0) {
          const { code } = armed
          armed = undefined
          throw Object.assign(new Error(`injected write failure: ${code}`), { code })
        }
        armed.remaining -= 1
      }
      return write()
    },
  }
}
