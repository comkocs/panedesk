/** Runtime failure supervision never changes durable business identities or replays uncertain writes. */
import { SEAT_ERROR_CODES, type SeatNodeStatus } from '@panedesk/dsh-seat'

type Failure = NonNullable<SeatNodeStatus['failure']>
type Site = 'startup-recovery' | 'scheduled-drive' | 'decision-notification' | 'callback-delivery'
  | 'preopen-retention' | 'owner-release'
const transportCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
  'node-tunnel-disconnected', 'node-deadline-exceeded', 'callback-timeout'])

function exceptionSummary(cause: unknown): { constructor?: string; name?: string; code?: string }[] {
  const entries: { constructor?: string; name?: string; code?: string }[] = []
  const seen = new Set<object>()
  const read = (value: object, key: string): unknown => {
    try {
      let current: object | null = value
      for (let depth = 0; current && depth < 4; depth++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor) return 'value' in descriptor ? descriptor.value : undefined
        const prototype: unknown = Object.getPrototypeOf(current)
        current = prototype !== null && typeof prototype === 'object' ? prototype : null
      }
    } catch (error) { void error /* Exception diagnostics cannot replace the supervised failure. */ }
    return undefined
  }
  const identifier = (value: unknown): string | undefined => typeof value === 'string'
    && /^[A-Za-z0-9._:-]{1,48}$/.test(value)
    && !/(?:token|secret|password|bearer|^sk-|^gh[pousr]_|[a-z0-9]{24})/i.test(value) ? value : undefined
  const visit = (value: unknown, depth: number): void => {
    if (depth >= 4 || entries.length >= 16 || value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const type = read(value, 'constructor')
    const constructor = identifier(typeof type === 'function' ? read(type, 'name') : undefined)
    const name = identifier(read(value, 'name')), code = identifier(read(value, 'code'))
    entries.push({ ...(constructor ? { constructor } : {}), ...(name ? { name } : {}), ...(code ? { code } : {}) })
    visit(read(value, 'cause'), depth + 1)
    const errors = read(value, 'errors')
    if (Array.isArray(errors)) {
      for (let index = 0; index < Math.min(errors.length, 16) && entries.length < 16; index++) {
        visit(read(errors, String(index)), depth + 1)
      }
    }
  }
  visit(cause, 0)
  return entries
}

/** Own one continuous unavailable interval; an unrecoverable failure cannot be overwritten by a transient one. */
export class EngineFailures {
  private current: Failure | undefined
  private nextDue = 0
  private alert: ReturnType<typeof setTimeout> | undefined
  private revision = 0
  private closed = false
  constructor(private readonly initialMs: number | undefined, private readonly log: (line: string) => void) {}

  /** Read a detached diagnostic, absent before a failure or after a verified successful retry.
   * @returns Safe failure fields without exception text.
   */
  snapshot(): Failure | undefined { return this.current ? { ...this.current } : undefined }

  /** Capture the failure generation before starting a complete recovery round.
   * @returns Monotonic runtime generation.
   */
  generation(): number { return this.revision }

  /** Decide whether automatic work may start without clearing its failure first.
   * @returns False during backoff or after an unrecoverable failure when supervision is enabled.
   */
  runnable(): boolean {
    return this.initialMs === undefined || !this.current || this.current.retryable && Date.now() >= this.nextDue
  }

  /** Record one failed attempt, retaining an earlier unrecoverable cause and the original interval start.
   * @param site - Fixed engine call site.
   * @param cause - Failure; unknown classifications log bounded identifiers only, never exception text.
   * @param code - Optional fixed site-specific diagnosis for failures without a precise public code.
   */
  record(site: Site, cause: unknown, code?: string): void {
    const classify = (error: unknown): { code: string; retryable: boolean } => {
      // Cordis waits for every listener and reports their failures together; all must permit retry.
      if (error instanceof AggregateError && error.errors.length) {
        const errors = error.errors.map((item: unknown) => classify(item))
        return errors.find(item => !item.retryable) ?? classify(error.errors[0])
      }
      const raw = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
      const known = typeof raw === 'string' && (Object.hasOwn(SEAT_ERROR_CODES, raw) || transportCodes.has(raw))
      // Never unwrap persistence errors even when their nested cause resembles a transport timeout.
      return { code: known ? raw : 'unclassified-error', retryable: known && transportCodes.has(raw) }
    }
    const classification = classify(cause)
    const safeCode = code ?? classification.code
    const retryable = code === undefined && classification.retryable
    const now = Date.now(), previous = this.current
    this.revision++
    const attempts = (previous?.attempts ?? 0) + 1
    const failure = { site, code: safeCode, since: previous?.since ?? new Date(now).toISOString(), retryable, attempts }
    this.current = previous && !previous.retryable ? { ...previous, attempts } : failure
    if (this.initialMs !== undefined) this.nextDue = now + Math.min(300000, this.initialMs * 2 ** Math.min(attempts - 1, 30))
    this.log(`Seat engine failure ${JSON.stringify({ ...failure, action: retryable ? 'retry' : 'stop-and-restart-after-repair',
      ...(safeCode === 'unclassified-error' ? { exception: exceptionSummary(cause) } : {}) })}`)
    if (!previous && !this.closed) {
      this.alert = setTimeout(() => {
        this.alert = undefined
        if (this.current) this.log(`Seat engine unavailable over ten minutes ${JSON.stringify(this.current)}`)
      }, 600001)
      this.alert.unref()
    }
  }

  /** Clear only a retryable failure after the entire round succeeds without a newer failure.
   * @param generation - Generation captured before the round.
   */
  succeeded(generation: number): void {
    if (this.initialMs === undefined || !this.current?.retryable || generation !== this.revision) return
    this.current = undefined
    if (this.alert) clearTimeout(this.alert)
    this.alert = undefined
  }

  /** Dispose the unavailable watchdog without implying recovery. */
  close(): void { this.closed = true; if (this.alert) clearTimeout(this.alert); this.alert = undefined }
}
