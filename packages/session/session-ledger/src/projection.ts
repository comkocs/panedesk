/** Deterministic call/run projection and conflict-preserving multi-node merging. */
import { canonicalJson, rebuildIndex, uniqueSlot } from './index-store.ts'
import type { LedgerEvent, LedgerLifecycle, LedgerQuery, LedgerRow, LedgerSnapshot, LedgerWatermark } from './types.ts'

/** Merge output keeps incompatible identities visible to callers. */
export interface LedgerMerge {
  events: readonly LedgerEvent[]
  conflicts: readonly { existing: LedgerEvent; incoming: LedgerEvent }[]
}

/** Merge node facts without silently selecting an incompatible call or event identity.
 * @param nodes - Validated event sequences, including offline imports.
 * @returns Deduplicated nonconflicting facts and the conflicting pairs excluded from projection.
 */
export function mergeLedger(nodes: readonly (readonly LedgerEvent[])[]): LedgerMerge {
  const all = nodes.flat().sort((a, b) => a.observedAt - b.observedAt
    || a.nodeId.localeCompare(b.nodeId) || a.eventId.localeCompare(b.eventId))
  const index = rebuildIndex(all)
  const badIds = new Set(index.conflicts.flatMap(pair => [pair.existing.eventId, pair.incoming.eventId]))
  const badSlots = new Set(index.conflicts.flatMap(pair => [uniqueSlot(pair.existing), uniqueSlot(pair.incoming)])
    .filter(slot => slot !== undefined))
  const badCalls = new Set(index.conflicts.flatMap(pair => [pair.existing.callId, pair.incoming.callId]).filter(id => id !== undefined))
  const badRuns = new Set(index.conflicts.flatMap(pair => [pair.existing, pair.incoming])
    .filter(event => event.kind === 'run/start' || event.kind === 'run/end').map(event => event.runId))
  const seen = new Set<string>()
  const events = [...index.events.values()].filter((event) => {
    const slot = uniqueSlot(event)
    if (badRuns.has(event.runId) || badIds.has(event.eventId) || (slot !== undefined && badSlots.has(slot))
      || (event.callId !== undefined && badCalls.has(event.callId))) return false
    const key = slot ?? event.eventId
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { events, conflicts: index.conflicts }
}

/** Fold runtime evidence into single-call rows and lifecycle rows.
 * @param events - Committed facts; conflicting identities are excluded and mark the view incomplete.
 * @param options - Query time, local node, freshness, filters, and durable scan watermarks.
 * @returns Snapshot with offline or stale observations never counted as confirmed live.
 */
export function foldLedger(events: readonly LedgerEvent[], options: {
  asOf: number
  localNodeId?: string
  observationMaxAgeMs: number
  filter?: LedgerQuery
  watermarks?: Readonly<Record<string, LedgerWatermark>>
  complete?: boolean
}): LedgerSnapshot {
  const merged = mergeLedger([events])
  const accepted = merged.events
  const rows: LedgerRow[] = []
  const filter = options.filter ?? {}
  const sessions = new Set<string>(filter.sessionId ? [filter.sessionId] : [])
  if (filter.includeChildren && filter.sessionId) {
    let changed = true
    while (changed) {
      changed = false
      for (const event of accepted) {
        if ((event.kind === 'call/start' || event.kind === 'run/start') && event.data.parentSessionId
          && sessions.has(event.data.parentSessionId) && !sessions.has(event.sessionId)) {
          sessions.add(event.sessionId)
          changed = true
        }
      }
    }
  }
  const index = rebuildIndex(accepted)
  for (const event of accepted) {
    if (event.kind === 'call/start') {
      const end = index.slots.get(JSON.stringify(['call/end', event.data.callId]))
      rows.push({ kind: 'call', start: event.data, ...(end?.kind === 'call/end' ? { finish: end.data } : {}) })
    } else if (event.kind === 'run/start') {
      const end = index.slots.get(JSON.stringify(['run/end', event.data.runId]))
      let liveness: LedgerLifecycle['liveness'] = end ? 'dead' : 'unknown'
      const observations = accepted.filter(item => item.kind === 'process/observed' && item.runId === event.runId)
        .sort((a, b) => b.observedAt - a.observedAt)
      const observation = observations[0]
      if (!end && observation?.kind === 'process/observed'
        && observation.nodeId === options.localNodeId && observation.identity.nodeId === observation.nodeId
        && observation.identity.verification === 'verified' && observation.identity.startIdentity
        && observation.observedAt <= options.asOf && options.asOf - observation.observedAt <= options.observationMaxAgeMs) {
        const identity = event.data.processIdentity
        if (!identity || (identity.pid === observation.identity.pid && identity.startIdentity === observation.identity.startIdentity
          && identity.bootIdentity === observation.identity.bootIdentity)) liveness = observation.liveness
      }
      rows.push({ kind: 'run', start: event.data, ...(end?.kind === 'run/end' ? { finish: end.data } : {}), liveness })
    } else if (event.kind !== 'call/end' && event.kind !== 'run/end') rows.push({ kind: 'event', event })
  }
  const selected = rows.filter((row) => {
    const start = row.kind === 'event' ? undefined : row.start
    const at = row.kind === 'event' ? row.event.observedAt : row.start.startedAt
    const context = row.kind === 'event' ? row.event : row.start
    if (filter.from !== undefined && at < filter.from || filter.to !== undefined && at >= filter.to) return false
    if (filter.sessionId && !sessions.has(context.sessionId)) return false
    if (filter.nodeId && context.nodeId !== filter.nodeId) return false
    for (const key of ['seat', 'window', 'taskId', 'accountLabel'] as const) {
      if (filter[key] !== undefined && start?.[key] !== filter[key]) return false
    }
    if (filter.model && (row.kind === 'call' ? row.finish?.effectiveModel ?? row.start.requestedModel : row.kind === 'run' ? row.start.effectiveModel : undefined) !== filter.model) return false
    if (filter.modelFamily && (row.kind !== 'call' || row.start.modelFamily !== filter.modelFamily)) return false
    if (filter.purpose && (row.kind !== 'call' || row.start.purpose !== filter.purpose)) return false
    return true
  })
  selected.sort((a, b) => {
    const at = (row: LedgerRow) => row.kind === 'event' ? row.event.observedAt : row.start.startedAt
    return at(a) - at(b) || canonicalJson(a).localeCompare(canonicalJson(b))
  })
  return {
    asOf: options.asOf, watermarks: options.watermarks ?? {},
    complete: (options.complete ?? true) && merged.conflicts.length === 0, rows: selected,
  }
}

/** Count unique confirmed sessions, including children without double counting a residency.
 * @param snapshot - A freshly observed lifecycle projection.
 * @returns Number of unique sessions with a live, unfinished run.
 */
export function runningSessions(snapshot: LedgerSnapshot): number {
  return new Set(snapshot.rows.flatMap(row => row.kind === 'run' && !row.finish && row.liveness === 'confirmed' ? [row.start.sessionId] : [])).size
}
