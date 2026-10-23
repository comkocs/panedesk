/** Reference-price budgets use integer micro-USD and retain unknown accounting evidence. */
import type { SessionId } from '@panedesk/dsh-session'
import type { LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import type { MicroUsd, SeatBudgetLimits, SeatBudgetSnapshot, SeatName, SeatAccountUsageResult } from '@panedesk/dsh-seat'
import { EngineError } from './journal.ts'

/** Convert decimal USD exactly, rounding sub-micro amounts upward rather than losing costs.
 * @param amount - nonnegative decimal USD from the reference ledger.
 * @returns integer micro-USD.
 */
export function microUsd(amount: string): MicroUsd {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new EngineError('budget-unverifiable', 'Reference cost is not a nonnegative decimal')
  const [whole = '0', fraction = ''] = amount.split('.')
  const rounded = /[1-9]/.test(fraction.slice(6)) ? 1n : 0n
  return (BigInt(whole) * 1000000n + BigInt(fraction.slice(0, 6).padEnd(6, '0')) + rounded).toString() as MicroUsd
}
/** Freeze a civil day from the call start, including late settlements.
 * @param time - host milliseconds.
 * @param timeZone - configured IANA accounting zone.
 * @returns ISO civil date.
 */
export function dayKey(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time)
  const part = (name: string) => {
    const value = parts.find(item => item.type === name)
    if (!value) throw new EngineError('budget-unverifiable', 'Civil day is unavailable')
    return value.value
  }
  return `${part('year')}-${part('month')}-${part('day')}`
}
/** Fold a complete authoritative M4 snapshot without adding a second cost journal.
 * @param ledger - latest call projections, including descendants and maintenance.
 * @param input - window identity and independently revisioned policy.
 * @returns known cost or explicit unknown debt.
 */
export function projectBudget(ledger: LedgerSnapshot, input: {
  sessionId: SessionId
  seat: SeatName
  limits: SeatBudgetLimits
  budgetRevision: number
  budgetTimeZone: string
  now: number
}): SeatBudgetSnapshot {
  const day = dayKey(input.now, input.budgetTimeZone)
  let windowCost = 0n, dailyCost = 0n, unknown = 0
  const seen = new Set<string>()
  for (const row of ledger.rows) {
    if (row.kind !== 'call' || seen.has(row.start.callId)) continue
    seen.add(row.start.callId)
    const window = row.start.sessionId === input.sessionId || row.start.rootSessionId === input.sessionId
    const sameSeat = row.start.seat === input.seat
    const today = dayKey(row.start.startedAt, input.budgetTimeZone) === day
    if (!window && !sameSeat) continue
    if (row.finish?.costUsd === undefined) { unknown++; continue }
    const cost = BigInt(microUsd(row.finish.costUsd))
    if (window) windowCost += cost
    if (sameSeat && today) dailyCost += cost
  }
  const known = ledger.complete && unknown === 0
  return { sessionId: input.sessionId, seat: input.seat, currency: 'USD', costState: known ? 'known' : 'unknown',
    windowCost: known ? windowCost.toString() as MicroUsd : null, dailyCost: known ? dailyCost.toString() as MicroUsd : null,
    limits: input.limits, dayKey: day, budgetTimeZone: input.budgetTimeZone, inFlightUnknown: unknown,
    watermark: ledger.asOf, budgetRevision: input.budgetRevision }
}
/** Thresholds govern only future turns; callers must not interrupt an admitted turn.
 * @param snapshot - current reference-price evidence.
 * @returns none, warning, stopped or unverifiable.
 */
export function budgetLevel(snapshot: SeatBudgetSnapshot): 'none' | 'warning' | 'stopped' | 'unverifiable' {
  const limited = snapshot.limits.windowBudgetUsd !== undefined || snapshot.limits.dailyBudgetUsd !== undefined
  if (!limited) return 'none'
  if (snapshot.costState !== 'known' || snapshot.windowCost === null || snapshot.dailyCost === null) return 'unverifiable'
  const pairs = [[snapshot.windowCost, snapshot.limits.windowBudgetUsd], [snapshot.dailyCost, snapshot.limits.dailyBudgetUsd]] as const
  if (pairs.some(([cost, limit]) => limit !== undefined && BigInt(cost) >= BigInt(limit))) return 'stopped'
  return pairs.some(([cost, limit]) => limit !== undefined && BigInt(cost) * 5n >= BigInt(limit) * 4n) ? 'warning' : 'none'
}
/** Account statistics preserve unknown labels and count physical attempts once.
 * @param ledger - reference snapshot filtered to the requested interval.
 * @returns rate-limit evidence without implementing account throttling.
 */
export function accountUsage(ledger: LedgerSnapshot): SeatAccountUsageResult {
  const groups = new Map<string | null, typeof ledger.rows[number][]>()
  for (const row of ledger.rows) {
    if (row.kind !== 'call') continue
    const label = row.finish?.accountLabel ?? null
    const group = groups.get(label) ?? []; group.push(row); groups.set(label, group)
  }
  return { watermark: ledger.asOf, complete: ledger.complete, queryCommand: 'dsh --profile ledger query --group-by account',
    accounts: [...groups].map(([accountLabel, rows]) => {
      let attempts429 = 0, attempts503 = 0, uniqueCalls429 = 0, uniqueCalls503 = 0, active = 0, peak = 0
      const points: { time: number; delta: number }[] = [], seen = new Set<string>()
      let complete = ledger.complete
      for (const row of rows) {
        if (row.kind !== 'call' || seen.has(row.start.callId)) continue
        seen.add(row.start.callId)
        const a = row.finish?.http429Count ?? (row.finish?.httpStatus === 429 ? 1 : 0)
        const b = row.finish?.http503Count ?? (row.finish?.httpStatus === 503 ? 1 : 0)
        attempts429 += a; attempts503 += b; uniqueCalls429 += Number(a > 0); uniqueCalls503 += Number(b > 0)
        points.push({ time: row.start.startedAt, delta: 1 })
        if (row.finish) points.push({ time: row.finish.endedAt, delta: -1 }); else complete = false
      }
      for (const point of points.sort((a, b) => a.time - b.time || b.delta - a.delta)) { active += point.delta
        peak = Math.max(peak, active) }
      return { accountLabel, attempts429, attempts503, uniqueCalls429, uniqueCalls503, concurrencyPeak: complete ? peak : null, complete }
    }) }
}
