/** Current-context threshold reminders use steer, not passive notice delivery. */
import type { SessionId } from '@panedesk/dsh-session'
import type { SeatContextUsage, SeatOperationId } from '@panedesk/dsh-seat'

/** A durable message bridge owns operation deduplication and next-boundary delivery. */
export interface ContextReminderDelivery {
  send(request: { sessionId: SessionId; operationId: SeatOperationId; messageClass: 'handoff'; mode: 'steer'; text: string }): Promise<void>
}

/** Latest-call estimates and compaction epochs belong to one provider instance. */
export class ContextUsageObserver {
  private readonly usage = new Map<SessionId, SeatContextUsage>()
  private readonly sent = new Set<string>()
  private readonly epochs = new Map<SessionId, number>()
  private readonly sending = new Map<string, Promise<void>>()
  constructor(private readonly delivery: ContextReminderDelivery) {}

  /** Sample the last call only; partial usage cannot be reported as a known total.
   * @param sessionId - observed window.
   * @param usage - provider usage, or missing evidence.
   * @param observedAt - host observation timestamp.
   * @returns dated context estimate.
   */
  sample(sessionId: SessionId,
    usage: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null, observedAt: string): SeatContextUsage {
    const values = usage === null ? [] : [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    const measured = values.length === 3 && values.every(value => value !== undefined && Number.isFinite(value) && value >= 0)
    const result: SeatContextUsage = measured ? { status: 'known', source: 'last-call-usage',
      tokens: values.reduce<number>((sum, value) => sum + (value ?? 0), 0), observedAt, estimated: true,
      contextEpoch: this.epochs.get(sessionId) ?? 0 } : { status: 'unknown', observedAt }
    this.usage.set(sessionId, result)
    return result
  }

  /** Committed compaction replaces the old estimate and advances its deduplication epoch.
   * @param sessionId - compacted window.
   * @param tokens - post-compaction surface estimate.
   * @param observedAt - compaction commit timestamp.
   */
  compacted(sessionId: SessionId, tokens: number, observedAt: string): void {
    const contextEpoch = (this.epochs.get(sessionId) ?? 0) + 1
    this.epochs.set(sessionId, contextEpoch)
    this.usage.set(sessionId, { status: 'known', source: 'compaction-surface', tokens, observedAt, estimated: true, contextEpoch })
  }

  /** Return explicit unknown evidence for unobserved windows.
   * @param sessionId - local window identity.
   * @param observedAt - query time.
   * @returns latest context estimate.
   */
  read(sessionId: SessionId, observedAt: string): SeatContextUsage { return this.usage.get(sessionId) ?? { status: 'unknown', observedAt } }

  /** Send once per threshold revision and epoch; the message provider persists the stable operation.
   * @param sessionId - target window.
   * @param threshold - configured limit, absent disables reminders.
   * @param revision - policy revision.
   * @param child - whether the reminder requests returning work to its parent.
   * @returns whether a reminder was delivered in this invocation.
   */
  async remind(sessionId: SessionId, threshold: number | undefined, revision: number, child: boolean): Promise<boolean> {
    const usage = this.usage.get(sessionId)
    if (threshold === undefined || usage?.status !== 'known' || usage.tokens < threshold) return false
    const key = `${sessionId}:context:${revision}:${usage.contextEpoch}`
    if (this.sent.has(key)) return false
    const pending = this.sending.get(key)
    if (pending !== undefined) { await pending; return false }
    const delivery = this.delivery.send({ sessionId, operationId: key as SeatOperationId, messageClass: 'handoff', mode: 'steer',
      text: child ? 'Context threshold reached. Return your results and delegate further work to a new agent.' : 'Context threshold reached. Consider replacing this window after reporting its pending work.' })
    this.sending.set(key, delivery)
    try { await delivery; this.sent.add(key); return true }
    finally { this.sending.delete(key) }
  }
}
