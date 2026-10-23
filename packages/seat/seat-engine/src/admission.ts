/** Pure admission evaluates all resources before any reservation can be committed. */
import type { SessionId } from '@panedesk/dsh-session'
import type { EngineMode, PendingReason, SeatDefinition, SeatRule, SeatTimeWindow, SeatBudgetSnapshot, HandoverPermit, SeatNodeId } from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'

/** Admission never acquires labels while another prerequisite remains pending. */
export type Admission = { status: 'allowed'; tags: readonly string[] } | { status: 'pending'; reason: PendingReason; blockedBy: readonly string[] } | { status: 'rejected'; code: 'seat-already-open' | 'cross-node-unsupported' }
/** Rule mode can tighten but never widen the project policy.
 * @param project - resolved project policy.
 * @param rule - optional rule restriction.
 * @returns least permissive mode.
 */
export function effectiveMode(project: EngineMode, rule?: EngineMode): EngineMode {
  if (project === 'off' || rule === 'off') return 'off'
  if (project === 'remind' || rule === 'remind') return 'remind'
  return 'auto'
}
/** Automatic windows use civil time and the starting weekday for overnight intervals.
 * @param windows - validated explicit time zones and intervals.
 * @param now - host time in milliseconds.
 * @returns whether any configured interval admits this instant.
 */
export function inTimeWindow(windows: readonly SeatTimeWindow[], now: number): boolean {
  return windows.length === 0 || windows.some((window) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: window.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
    const value = (type: string) => parts.find(part => part.type === type)?.value ?? ''
    const minute = Number(value('hour')) * 60 + Number(value('minute'))
    const parse = (time: string) => { const [hour = 0, minutes = 0] = time.split(':').map(Number); return hour * 60 + minutes }
    const start = parse(window.start), end = parse(window.end)
    let day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'))
    const overnight = start > end
    if (overnight && minute < end) day = (day + 6) % 7
    return (!window.weekdays || window.weekdays.includes(day))
      && (overnight ? minute >= start || minute < end : minute >= start && minute < end)
  })
}
/** Budget uncertainty blocks only when limits have been configured.
 * @param budget - current reference-price evidence.
 * @returns pending reason or null for available budget.
 */
export function budgetReason(budget: SeatBudgetSnapshot): 'budget-full' | 'budget-unverifiable' | null {
  const { windowBudgetUsd, dailyBudgetUsd } = budget.limits
  if (windowBudgetUsd === undefined && dailyBudgetUsd === undefined) return null
  if (budget.costState === 'unknown' || budget.windowCost === null || budget.dailyCost === null) return 'budget-unverifiable'
  return (windowBudgetUsd !== undefined && BigInt(budget.windowCost) >= BigInt(windowBudgetUsd))
    || (dailyBudgetUsd !== undefined && BigInt(budget.dailyCost) >= BigInt(dailyBudgetUsd)) ? 'budget-full' : null
}
/** Resolve one resource request against the current committed view.
 * @param input - frozen definition, policy, budget and optional transaction-bound handover.
 * @returns refusal, pending reason, or the complete label set to reserve atomically.
 */
export function reserveOpen(input: {
  projection: EngineProjection
  definition: SeatDefinition
  rule?: SeatRule
  nodeId: SeatNodeId
  aliases: Readonly<Record<string, SeatNodeId>>
  engine: boolean
  now: number
  nodeLimit?: number
  budget: SeatBudgetSnapshot
  replacement?: HandoverPermit
  sessionId: SessionId
}): Admission {
  const pending = (reason: PendingReason, blockedBy: readonly string[] = []): Admission => ({ status: 'pending', reason, blockedBy })
  const { projection, definition, rule, replacement } = input
  if (input.aliases[definition.node] !== input.nodeId) return { status: 'rejected', code: 'cross-node-unsupported' }
  const resources = [...projection.resources.values()]
  const own = resources.filter(resource => resource.seat === definition.seat)
  const transaction = replacement ? projection.replacements.get(replacement.replacementId) : undefined
  const handover = replacement?.newSessionId === input.sessionId
    && (replacement.state === 'issued' || replacement.state === 'first-turn-running')
    && transaction?.phase === 'queued' && transaction.newSessionId === null
    && transaction.oldSessionId === replacement.oldSessionId
    && own.some(resource => resource.owner.sessionId === replacement.oldSessionId && resource.owner.ownerEpoch === replacement.ownerEpoch)
  const created = own.filter((resource) => {
    const phase = projection.opens.get(resource.owner.sessionId)?.phase
    return phase !== undefined && phase !== 'intent' && phase !== 'creating'
  })
  if (!handover && created.length >= definition.maxOpenSessions) return { status: 'rejected', code: 'seat-already-open' }
  if (input.engine && !inTimeWindow(rule?.timeWindows ?? [], input.now)) return pending('time-window')
  if (input.engine && input.nodeLimit !== undefined && resources.reduce((sum, resource) => sum + resource.engineWindowUnits, 0) >= input.nodeLimit) return pending('node-capacity')
  // A queued replacement may reserve only its old/new pair; ordinary opens retain the configured limit.
  const seatLimit = handover ? 2 : definition.maxOpenSessions
  if (own.reduce((sum, resource) => sum + resource.seatWindowUnits, 0) >= seatLimit) return pending('seat-capacity')
  const tags = handover ? [] : [...new Set(rule?.exclusiveTags ?? [])].sort()
  const blocked = tags.filter(tag => resources.some(resource => resource.exclusiveTags.includes(tag)))
  if (blocked.length) return pending('exclusive-tag', blocked)
  const reason = budgetReason(input.budget)
  if (reason) return pending(reason)
  return { status: 'allowed', tags }
}
