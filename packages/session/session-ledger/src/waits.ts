/** Rebuild tool-wait attribution from immutable response identities and wait facts. */
import type { LedgerCall, LedgerInterval, LedgerRow, LedgerWaitSummary } from './types.ts'

function scope(value: { nodeId: string; sessionId: string; runId: string }): string {
  return JSON.stringify([value.nodeId, value.sessionId, value.runId])
}
function intervalKey(interval: LedgerInterval): string {
  return JSON.stringify([interval.kind, interval.toolCallId, interval.startedAt])
}
function summarize(intervals: readonly LedgerInterval[]): LedgerWaitSummary {
  const categories: LedgerWaitSummary['categories'] = {}
  const ids = new Map<LedgerInterval['kind'], Set<string>>()
  for (const interval of intervals) {
    const category = categories[interval.kind] ?? { toolCalls: 0, durationMs: 0 }
    const tools = ids.get(interval.kind) ?? new Set<string>()
    if (interval.toolCallId) tools.add(interval.toolCallId)
    ids.set(interval.kind, tools)
    category.toolCalls = tools.size
    category.durationMs += Math.max(0, interval.durationMs ?? (interval.endedAt === undefined ? 0 : interval.endedAt - interval.startedAt))
    categories[interval.kind] = category
  }
  return { categories }
}

/** Discard derived fields before comparing immutable exported rows.
 * @param row - Public row, possibly projected from an older snapshot.
 * @returns Original facts without cached wait projections.
 */
export function withoutWaitProjection(row: LedgerRow): LedgerRow {
  if (row.kind === 'event') return row
  if (row.kind === 'call') return { kind: row.kind, start: row.start, ...row.finish === undefined ? {} : { finish: row.finish } }
  return { kind: row.kind, start: row.start, liveness: row.liveness, ...row.finish === undefined ? {} : { finish: row.finish } }
}

/** Join late waits to their unique issuing response, never to a neighboring time window.
 * @param input - Immutable rows and optional stale derived fields.
 * @returns Fresh projections; terminal facts and wall/model timings remain unchanged.
 */
export function projectWaits(input: readonly LedgerRow[]): LedgerRow[] {
  const rows = input.map(withoutWaitProjection)
  const calls = rows.filter((row): row is LedgerCall => row.kind === 'call')
  const owners = new Map<string, Set<LedgerCall>>()
  for (const call of calls) for (const id of call.finish?.toolCallIds ?? []) {
    if (!id) continue
    const key = JSON.stringify([scope(call.start), id])
    const matches = owners.get(key) ?? new Set<LedgerCall>()
    matches.add(call)
    owners.set(key, matches)
  }
  const facts = new Map<string, Extract<LedgerRow, { kind: 'event' }>['event']>()
  for (const row of rows) {
    if (row.kind !== 'event' || (row.event.kind !== 'wait/start' && row.event.kind !== 'wait/end')) continue
    const key = JSON.stringify([scope(row.event), intervalKey(row.event.interval)])
    if (!facts.has(key) || row.event.kind === 'wait/end') facts.set(key, row.event)
  }
  const assigned = new Map<LedgerCall, LedgerInterval[]>()
  const unassigned = new Map<string, LedgerInterval[]>()
  for (const event of facts.values()) {
    if (event.kind !== 'wait/start' && event.kind !== 'wait/end') continue
    const interval = event.interval
    const matches = interval.toolCallId ? owners.get(JSON.stringify([scope(event), interval.toolCallId])) : undefined
    const owner = matches?.size === 1 ? [...matches][0] : undefined
    if (owner !== undefined && (event.callId === undefined || event.callId === owner.start.callId)) {
      const waits = assigned.get(owner) ?? []
      waits.push(interval)
      assigned.set(owner, waits)
    } else {
      const waits = unassigned.get(scope(event)) ?? []
      waits.push(interval)
      unassigned.set(scope(event), waits)
    }
  }
  for (const call of calls) {
    if (call.finish?.toolCallIds === undefined && !assigned.has(call)) continue
    call.waits = assigned.get(call) ?? []
    call.waitSummary = summarize(call.waits)
  }
  const callsByRun = new Map<string, LedgerCall[]>()
  for (const call of calls) {
    const key = scope(call.start)
    const members = callsByRun.get(key) ?? []
    members.push(call)
    callsByRun.set(key, members)
  }
  for (const row of rows) {
    if (row.kind !== 'run') continue
    const members = callsByRun.get(scope(row.start)) ?? []
    row.waits = members.flatMap(call => call.waits ?? [])
    const categories: LedgerWaitSummary['categories'] = {}
    for (const call of members) for (const [kind, value] of Object.entries(call.waitSummary?.categories ?? {})) {
      const key = kind as LedgerInterval['kind']
      const sum = categories[key] ?? { toolCalls: 0, durationMs: 0 }
      sum.toolCalls += value.toolCalls
      sum.durationMs += value.durationMs
      categories[key] = sum
    }
    row.waitSummary = { categories }
    row.unassignedWaits = unassigned.get(scope(row.start)) ?? []
    row.unassignedWaitSummary = summarize(row.unassignedWaits)
  }
  return rows
}
