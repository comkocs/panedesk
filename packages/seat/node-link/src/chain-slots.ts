/** Bounded execution and control dispatches have independent admission counters. */
import { object } from '@panedesk/dsh-host-admin'

/** Reserve control capacity without allowing business requests to consume it. */
export class ChainSlots {
  private business = 0
  private control = 0
  private stopped = false
  private readonly active = new Set<Promise<unknown>>()
  constructor(private readonly maxBusiness: number, private readonly maxControl: number) {
    if (!Number.isSafeInteger(maxBusiness) || maxBusiness < 1 || !Number.isSafeInteger(maxControl) || maxControl < 1
      || !Number.isSafeInteger(maxBusiness + maxControl)) throw new Error('Node chain capacity rejected')
  }

  /** Include the separately bounded control reserve in the underlying listener limit.
   * @returns Maximum authenticated requests admitted by the carrier.
   */
  capacity(): number { return this.maxBusiness + this.maxControl }

  /** Classify only fixed control discriminators; downstream decoders still validate every field.
   * @param value - Complete parsed authenticated frame.
   * @param dispatch - Original dispatcher, which owns authorization and result validation.
   * @returns Dispatch result, or rejection before any business work begins.
   */
  run(value: unknown, dispatch: () => Promise<unknown>): Promise<unknown> {
    const control = object(value) && (value.type === 'hello' || value.type === 'receipt'
      || value.type === 'delegation-evidence' || value.method === 'chain.operation' || value.method === 'source.checkAdmission')
    if (this.stopped || (control ? this.control >= this.maxControl : this.business >= this.maxBusiness)) {
      return Promise.reject(new Error('Node chain dispatch capacity unavailable'))
    }
    if (control) this.control++
    else this.business++
    const work = Promise.resolve().then(dispatch)
    this.active.add(work)
    const release = (): void => {
      this.active.delete(work)
      if (control) this.control--
      else this.business--
    }
    void work.then(release, release)
    return work
  }

  /** Withdraw ingress synchronously before awaiting every already accepted dispatch.
   * @returns Completion after accepted business and control requests settle.
   */
  async close(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.active])
  }
}
