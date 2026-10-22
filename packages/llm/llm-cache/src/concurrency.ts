/** FIFO admission owned by one harness cache plugin instance. */
import type { FamilyConcurrencyLimit } from './types.ts'

interface Waiter {
  grant: () => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  abort: () => void
}
interface FamilyQueue {
  limit: number
  active: number
  queue: Waiter[]
}

/** Cancellable model-family admission; disposal rejects queued requests, never live requests. */
export class FamilySemaphore {
  private readonly families = new Map<string, FamilyQueue>()
  private closed = false

  constructor(limits: readonly FamilyConcurrencyLimit[]) {
    for (const { modelFamily, maxInFlight } of limits) {
      if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || this.families.has(modelFamily)) {
        throw new Error('Concurrency limits must be positive integers with unique family names')
      }
      this.families.set(modelFamily, { limit: maxInFlight, active: 0, queue: [] })
    }
  }

  /** Whether admission would wait; unconfigured families are unlimited.
   * @param family - resolved provider family.
   * @returns whether the family has exhausted its permits.
   */
  saturated(family: string): boolean {
    const state = this.families.get(family)
    return state !== undefined && state.active >= state.limit
  }

  /** Acquire a single idempotently releasable permit; cancellation removes only its waiter.
   * @param family - resolved provider family shared by all routes.
   * @param signal - optional cancellation; omission waits until admission or disposal.
   * @returns release capability for this request alone.
   */
  async acquire(family: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Model admission is closed')
    const state = this.families.get(family)
    if (state === undefined) return () => {}
    if (state.active >= state.limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          ...signal === undefined ? {} : { signal }, reject,
          grant: resolve,
          abort: () => {
            const index = state.queue.indexOf(waiter)
            if (index !== -1) state.queue.splice(index, 1)
            reject(new Error('Model admission cancelled', { cause: signal?.reason }))
          },
        }
        state.queue.push(waiter)
        signal?.addEventListener('abort', waiter.abort, { once: true })
      })
    } else {
      state.active += 1
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const waiter = state.queue.shift()
      if (waiter === undefined) {
        state.active -= 1
      } else {
        waiter.signal?.removeEventListener('abort', waiter.abort)
        waiter.grant()
      }
    }
  }

  /** Reject all queued requests while allowing acquired permits to drain. */
  dispose(): void {
    this.closed = true
    for (const state of this.families.values()) {
      for (const waiter of state.queue.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.abort)
        waiter.reject(new Error('Model admission is closed'))
      }
    }
  }
}
