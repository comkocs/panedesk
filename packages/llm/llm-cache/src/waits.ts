/** Join observed tool waits by the issuing response, never by physical overlap. */
import type { LedgerCallStart, LedgerInterval, LedgerSnapshot } from '@panedesk/dsh-session-ledger'

/** Select paired wait facts already visible when a model response settles.
 * @param snapshot - Session-scoped observations at settlement.
 * @param call - Immutable issuing call identity.
 * @param toolCallIds - Complete tool-call identities observed in this response.
 * @returns Deduplicated full intervals; late facts are joined by the ledger projection.
 */
export function callWaits(snapshot: LedgerSnapshot, call: LedgerCallStart,
  toolCallIds: readonly NonNullable<LedgerInterval['toolCallId']>[]): LedgerInterval[] {
  const intervals = new Map<string, LedgerInterval>()
  for (const row of snapshot.rows) {
    if (row.kind !== 'event') continue
    const event = row.event
    if ((event.kind !== 'wait/start' && event.kind !== 'wait/end') || event.runId !== call.runId
      || event.nodeId !== call.nodeId || event.sessionId !== call.sessionId
      || (event.callId !== undefined && event.callId !== call.callId)) continue
    const interval = event.interval
    if (!interval.toolCallId || !toolCallIds.includes(interval.toolCallId)) continue
    const key = JSON.stringify([interval.kind, interval.toolCallId, interval.startedAt])
    if (!intervals.has(key) || event.kind === 'wait/end') intervals.set(key, interval)
  }
  return [...intervals.values()]
}
