/** Join only observed waits overlapping one physical call's lifetime. */
import type { LedgerCallStart, LedgerInterval, LedgerSnapshot } from '@panedesk/dsh-session-ledger'

/** Select complete or open wait facts without attributing adjacent calls or other runs.
 * @param snapshot - session-scoped durable observations at settlement.
 * @param call - the immutable physical call start.
 * @param endedAt - the physical call's wall-clock end.
 * @returns paired, deduplicated intervals clipped to this call; open waits remain open.
 */
export function callWaits(snapshot: LedgerSnapshot, call: LedgerCallStart, endedAt: number): LedgerInterval[] {
  const intervals = new Map<string, LedgerInterval>()
  for (const row of snapshot.rows) {
    if (row.kind !== 'event') continue
    const event = row.event
    if ((event.kind !== 'wait/start' && event.kind !== 'wait/end') || event.runId !== call.runId
      || event.nodeId !== call.nodeId || event.sessionId !== call.sessionId
      || (event.callId !== undefined && event.callId !== call.callId)) continue
    const interval = event.interval
    const key = JSON.stringify([interval.kind, interval.toolCallId, interval.startedAt])
    if (!intervals.has(key) || event.kind === 'wait/end') intervals.set(key, interval)
  }
  return [...intervals.values()].flatMap((interval) => {
    const stop = interval.endedAt ?? endedAt
    const start = Math.max(call.startedAt, interval.startedAt)
    const end = Math.min(endedAt, stop)
    if (end <= start) return []
    if (interval.endedAt === undefined) return [{ ...interval, startedAt: start }]
    const clipped = Math.max(0, start - interval.startedAt) + Math.max(0, stop - end)
    return [{ ...interval, startedAt: start, endedAt: end,
      durationMs: Math.max(0, (interval.durationMs ?? stop - interval.startedAt) - clipped) }]
  })
}
