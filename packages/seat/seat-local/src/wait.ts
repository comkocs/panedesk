/** Durable wait transitions use snapshot-subscribe-snapshot to avoid missed terminal observations. */
import type { CancelSeatWaitRequest, CancelSeatWaitResult, RegisterSeatWaitRequest, RegisterSeatWaitResult,
  SeatRejected, SeatWait, WaitId, WaitObject, WaitObservation } from '@panedesk/dsh-seat'
import { digest } from './store.ts'
import { rejected } from './errors.ts'

/** The engine serializes CAS and durable wake receipts; observation providers never own wait state. */
export interface WaitRuntime {
  authorize(request: RegisterSeatWaitRequest): Promise<SeatRejected | null>
  register(request: RegisterSeatWaitRequest): Promise<SeatWait | SeatRejected>
  read(waitId: WaitId): Promise<SeatWait | null>
  observe(waitId: WaitId, observation: WaitObservation): Promise<SeatWait>
  cancel(request: CancelSeatWaitRequest): Promise<CancelSeatWaitResult>
  snapshot(object: WaitObject): Promise<WaitObservation | null>
  subscribe(object: WaitObject, listener: (observation: WaitObservation) => Promise<void>): () => Promise<void>
  wake(wait: SeatWait, delivery: { messageClass: 'handoff'; mode: 'steer'; text: string }): Promise<void>
}

/** One coordinator owns subscriptions and drains them on cancellation, settlement and unload. */
export class WaitCoordinator {
  private readonly subscriptions = new Map<WaitId, (() => Promise<void>)[]>()
  private readonly running = new Set<Promise<void>>()
  private disposed = false
  constructor(private readonly runtime: WaitRuntime) {}

  /** Commit registration without waiting for the observed tasks to finish.
   * @param request - authenticated objects and stable wait identity.
   * @returns persisted registration; callers can immediately conclude their tool turn.
   */
  async register(request: RegisterSeatWaitRequest): Promise<RegisterSeatWaitResult> {
    if (this.disposed) return rejected('unavailable', 'Wait observation is stopping.', 'Retry when the provider is ready.')
    if (!request.objects.length || new Set(request.objects.map(digest)).size !== request.objects.length) {
      return rejected('invalid-request', 'Wait objects must be nonempty and distinct.', 'List each pending object once.')
    }
    const refusal = await this.runtime.authorize(request)
    if (refusal !== null) return refusal
    const wait = await this.runtime.register(request)
    if ('status' in wait) return wait
    await this.watch(wait)
    return { status: 'registered', wait: (await this.runtime.read(wait.waitId)) ?? wait }
  }

  /** Restore a committed registration after owner restart without registering another wake.
   * @param wait - engine-projected registration.
   */
  async watch(wait: SeatWait): Promise<void> {
    if (this.disposed || wait.phase === 'cancelled' || wait.phase === 'woken') return
    if (wait.phase === 'satisfied') { await this.deliver(wait); return }
    if (this.subscriptions.has(wait.waitId)) return
    const disposers: (() => Promise<void>)[] = []
    this.subscriptions.set(wait.waitId, disposers)
    try {
      for (const object of wait.objects) {
        const before = await this.runtime.snapshot(object)
        disposers.push(this.runtime.subscribe(object, observation => this.track(this.observed(wait.waitId, observation))))
        if (before !== null) await this.observed(wait.waitId, before)
        const after = await this.runtime.snapshot(object)
        if (after !== null) await this.observed(wait.waitId, after)
      }
      const current = await this.runtime.read(wait.waitId)
      if (current?.phase !== 'registered') await this.unwatch(wait.waitId)
    } catch (error) { await this.unwatch(wait.waitId); throw error }
  }

  private track(task: Promise<void>): Promise<void> {
    this.running.add(task)
    return task.finally(() => { this.running.delete(task) })
  }

  private async observed(waitId: WaitId, observation: WaitObservation): Promise<void> {
    const wait = await this.runtime.observe(waitId, observation)
    if (wait.phase === 'satisfied') await this.deliver(wait)
  }

  private async deliver(wait: SeatWait): Promise<void> {
    await this.runtime.wake(wait, { messageClass: 'handoff', mode: 'steer',
      text: `Wait ${wait.waitId}: ${wait.observations.map(item => `${item.object.kind} ${item.object.id}: ${item.outcome}`).join('; ')}` })
    // Subscription cleanup follows durable wake so delivery failures remain recoverable.
  }

  /** Cancel only the observation; task producers retain ownership of their tasks.
   * @param request - expected registration version.
   * @returns durable cancellation or already-settled state.
   */
  async cancel(request: CancelSeatWaitRequest): Promise<CancelSeatWaitResult> {
    const result = await this.runtime.cancel(request)
    if (result.status !== 'rejected' && result.wait.phase !== 'registered') await this.unwatch(request.waitId)
    return result
  }

  private async unwatch(waitId: WaitId): Promise<void> {
    const disposers = this.subscriptions.get(waitId) ?? []
    this.subscriptions.delete(waitId)
    for (const dispose of disposers) await dispose()
  }

  /** Stop subscriptions, then drain already accepted observation callbacks.
   * @returns after no owned callbacks or registrations remain.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const waitId of this.subscriptions.keys()) await this.unwatch(waitId)
    await Promise.all(this.running)
  }
}
