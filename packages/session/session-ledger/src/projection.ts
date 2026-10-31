/** Deterministic call/run projection and conflict-preserving multi-node merging. */
import { canonicalJson, rebuildIndex, uniqueSlot } from './index-store.ts'
import { projectWaits } from './waits.ts'
import type { LedgerEvent, LedgerLifecycle, LedgerQuery, LedgerRow, LedgerSnapshot, LedgerWatermark, MessageLedgerEvent, LedgerMessage, LedgerMessagePage, LedgerSessionPage } from './types.ts'
import type { MessageCursor, MessageQuery, MessageStatus } from '@panedesk/dsh-message-delivery'

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
  const projection = new LedgerProjection()
  projection.apply(merged.events)
  return projection.snapshot({ ...options, complete: (options.complete ?? true) && merged.conflicts.length === 0 })
}

/** Read-owned incremental rows; only committed, nonconflicting facts may be applied. */
export class LedgerProjection {
  private readonly facts = new Map<string, LedgerEvent>()
  private readonly rows = new Map<string, LedgerRow>()
  private readonly observations = new Map<string, Extract<LedgerEvent, { kind: 'process/observed' }>>()

  /** Fold newly synchronized facts, retaining deterministic transport-duplicate selection.
   * @param events - Newly committed facts from a conflict-free journal.
   */
  apply(events: readonly LedgerEvent[]): void {
    for (const event of events) {
      const key = uniqueSlot(event) ?? event.eventId
      const prior = this.facts.get(key)
      if (prior && compareFacts(prior, event) <= 0) continue
      this.facts.set(key, event)
      if (event.kind === 'call/start' || event.kind === 'call/end') {
        const start = this.facts.get(JSON.stringify(['call/start', event.data.callId]))
        const end = this.facts.get(JSON.stringify(['call/end', event.data.callId]))
        if (start?.kind === 'call/start') this.rows.set(`call:${event.data.callId}`, {
          kind: 'call', start: start.data, ...end?.kind === 'call/end' ? { finish: end.data } : {},
        })
      } else if (event.kind === 'run/start' || event.kind === 'run/end') {
        const start = this.facts.get(JSON.stringify(['run/start', event.data.runId]))
        const end = this.facts.get(JSON.stringify(['run/end', event.data.runId]))
        if (start?.kind === 'run/start') this.rows.set(`run:${event.data.runId}`, {
          kind: 'run', start: start.data, liveness: end ? 'dead' : 'unknown',
          ...end?.kind === 'run/end' ? { finish: end.data } : {},
        })
      } else {
        this.rows.set(`event:${key}`, { kind: 'event', event })
        if (event.kind === 'process/observed') {
          const previous = this.observations.get(event.runId)
          if (!previous || event.observedAt > previous.observedAt
            || event.observedAt === previous.observedAt && compareFacts(event, previous) < 0) {
            this.observations.set(event.runId, event)
          }
        }
      }
    }
  }

  /** Materialize detached projections with current freshness and immutable fact ownership.
   * @param options - Read instant, local identity, selection and journal integrity.
   * @returns Ordered rows; elapsed freshness never mutates retained facts.
   */
  snapshot(options: Parameters<typeof foldLedger>[1]): LedgerSnapshot {
    const rows = [...this.rows.values()].map((row): LedgerRow => {
      if (row.kind !== 'run' || row.finish) return row
      let liveness: LedgerLifecycle['liveness'] = 'unknown'
      const observation = this.observations.get(row.start.runId)
      if (observation && observation.nodeId === options.localNodeId
        && observation.identity.nodeId === observation.nodeId
        && observation.identity.verification === 'verified' && observation.identity.startIdentity
        && observation.observedAt <= options.asOf && options.asOf - observation.observedAt <= options.observationMaxAgeMs) {
        const identity = row.start.processIdentity
        if (!identity || (identity.pid === observation.identity.pid && identity.startIdentity === observation.identity.startIdentity
          && identity.bootIdentity === observation.identity.bootIdentity)) liveness = observation.liveness
      }
      return { ...row, liveness }
    })
    const filter = options.filter ?? {}
    const sessions = new Set<string>(filter.sessionId ? [filter.sessionId] : [])
    if (filter.includeChildren && filter.sessionId) {
      const children = new Map<string, Set<string>>()
      for (const row of rows) {
        if (row.kind === 'event' || !row.start.parentSessionId) continue
        const entries = children.get(row.start.parentSessionId) ?? new Set<string>()
        entries.add(row.start.sessionId)
        children.set(row.start.parentSessionId, entries)
      }
      for (const session of sessions) for (const child of children.get(session) ?? []) sessions.add(child)
    }
    const selected = projectWaits(rows).filter((row) => {
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
      complete: options.complete ?? true, rows: structuredClone(selected),
    }
  }
}

function compareFacts(a: LedgerEvent, b: LedgerEvent): number {
  return a.observedAt - b.observedAt || a.nodeId.localeCompare(b.nodeId) || a.eventId.localeCompare(b.eventId)
}

/** Fold message versions before applying current-state filters or pagination.
 * @param events - Validated runtime facts; repeated identical versions are deduplicated.
 * @param query - Current state, creation-time, Session, and unanswered filters.
 * @param asOf - Wall-clock cutoff used for unanswered age.
 * @param complete - Full journal integrity, propagated even for empty selections.
 * @returns Ordered statuses with first state times and explicit integrity.
 */
export function foldMessages(
  events: readonly MessageLedgerEvent[], query: MessageQuery, asOf: number, complete: boolean,
): LedgerMessagePage {
  const grouped = new Map<string, Extract<MessageLedgerEvent, { kind: 'message/state' }>[]>()
  const quarantined = events.filter(event => event.kind === 'message/quarantined')
  for (const event of events) {
    if (event.kind !== 'message/state') continue
    const key = canonicalJson([event.nodeId, event.data.messageId])
    const group = grouped.get(key) ?? []
    group.push(event)
    grouped.set(key, group)
  }
  const items: LedgerMessage[] = []
  for (const group of grouped.values()) {
    group.sort((a, b) => a.data.stateVersion - b.data.stateVersion || a.eventId.localeCompare(b.eventId))
    const versions = new Map<number, Extract<MessageLedgerEvent, { kind: 'message/state' }>>()
    let conflict = false
    for (const event of group) {
      const prior = versions.get(event.data.stateVersion)
      if (prior && canonicalJson(prior) !== canonicalJson(event)) conflict = true
      else versions.set(event.data.stateVersion, event)
    }
    if (conflict) { complete = false; continue }
    const ordered = [...versions.values()]
    const last = ordered.at(-1)
    const first = ordered[0]
    if (last === undefined || first === undefined) continue
    const isolated = quarantined.filter(event => event.nodeId === last.nodeId && event.data.messageId === last.data.messageId)
      .sort((a, b) => a.observedAt - b.observedAt || a.eventId.localeCompare(b.eventId)).at(-1)
    const data = isolated ? { ...last.data, state: 'rejected' as const, transition: 'rejected' as const,
      reason: 'record-corrupt' as const, observedAt: isolated.observedAt, deliveryOutcome: 'rejected' as const, pending: false } : last.data
    const stateTimes: Partial<Record<MessageStatus['state'], number>> = {}
    for (const event of ordered) stateTimes[event.data.state] ??= event.data.observedAt
    if (isolated) stateTimes.rejected ??= isolated.observedAt
    const createdAt = first.data.observedAt
    let phase: MessageStatus['phase'] = data.state === 'injected' ? 'dispatched' : data.state === 'queued' ? 'pending' : 'settled'
    if (data.transition === 'claimed' || data.transition === 'appended' || data.transition === 'delivery-uncertain') phase = data.transition
    const item: LedgerMessage = { messageId: data.messageId, nodeId: last.nodeId, state: data.state, phase,
      revision: data.revision, stateVersion: data.stateVersion, createdAt, data, stateTimes,
      transitions: [...ordered.map(event => ({ cursor: event.eventId as string as MessageCursor, nodeId: event.nodeId, data: event.data })),
        ...isolated ? [{ cursor: isolated.eventId as string as MessageCursor, nodeId: isolated.nodeId, data }] : []] }
    if (query.nodeId !== undefined && item.nodeId !== query.nodeId
      || query.sessionId !== undefined && data.senderSessionId !== query.sessionId && data.targetSessionId !== query.sessionId
      || query.senderSessionId !== undefined && data.senderSessionId !== query.senderSessionId
      || query.targetSessionId !== undefined && data.targetSessionId !== query.targetSessionId
      || query.from !== undefined && createdAt < query.from || query.to !== undefined && createdAt >= query.to
      || query.states !== undefined && !query.states.includes(data.state)
      || query.messageClasses !== undefined && !query.messageClasses.includes(data.messageClass)) continue
    if (query.unansweredOlderThanMinutes !== undefined) {
      if (!Number.isFinite(query.unansweredOlderThanMinutes) || query.unansweredOlderThanMinutes < 0) throw new Error('Unanswered age must be nonnegative')
      if (data.messageClass === 'notice' || stateTimes.responded !== undefined
        || createdAt >= asOf - query.unansweredOlderThanMinutes * 60_000
        || !query.includeTerminal && ['withdrawn', 'invalidated', 'rejected'].includes(data.state)) continue
    }
    items.push(item)
  }
  items.sort((a, b) => a.createdAt - b.createdAt || a.nodeId.localeCompare(b.nodeId) || a.messageId.localeCompare(b.messageId))
  const cursorOf = (item: LedgerMessage) => `message:${Buffer.from(canonicalJson([item.nodeId, item.messageId])).toString('base64url')}` as MessageCursor
  const start = query.cursor === undefined ? -1 : items.findIndex(item => cursorOf(item) === query.cursor)
  if (query.cursor !== undefined && start < 0) throw new Error('Unknown message projection cursor')
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) throw new Error('Message limit must be a positive safe integer')
  const selected = items.slice(start + 1)
  const page = selected.slice(0, query.limit)
  const last = page.at(-1)
  return { items: page, asOf, complete, ...last && page.length < selected.length ? { nextCursor: cursorOf(last) } : {} }
}

/** Group independent call and message views by Session, preserving human-origin unassigned facts.
 * @param calls - Existing call projection, unchanged by message accounting.
 * @param messages - Complete, unpaginated message projection for the same selection.
 * @returns Session groups and conjunction of both integrity flags; this is not a cross-journal transaction.
 */
export function joinSessionLedgers(calls: LedgerSnapshot, messages: LedgerMessagePage): LedgerSessionPage {
  const groups = new Map<LedgerSessionPage['sessions'][number]['sessionId'], { sessionId: LedgerSessionPage['sessions'][number]['sessionId']; calls: LedgerRow[]; messages: LedgerMessage[] }>()
  const groupFor = (sessionId: LedgerSessionPage['sessions'][number]['sessionId']) => {
    let group = groups.get(sessionId)
    if (!group) { group = { sessionId, calls: [], messages: [] }; groups.set(sessionId, group) }
    return group
  }
  for (const row of calls.rows) groupFor(row.kind === 'event' ? row.event.sessionId : row.start.sessionId).calls.push(row)
  const unassignedMessages: LedgerMessage[] = []
  for (const message of messages.items) {
    const sessions = new Set([message.data.senderSessionId, message.data.targetSessionId].filter(id => id !== null))
    if (!sessions.size) unassignedMessages.push(message)
    for (const sessionId of sessions) groupFor(sessionId).messages.push(message)
  }
  return { asOf: Math.max(calls.asOf, messages.asOf), complete: calls.complete && messages.complete,
    sessions: [...groups.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)), unassignedMessages }
}

/** Export message statuses as JSONL with an integrity header, including empty results.
 * @param page - Selected message projection page.
 * @returns Metadata line followed by body-free status rows, each carrying schema version and integrity.
 */
export function exportMessages(page: LedgerMessagePage): string {
  return [canonicalJson({ schemaVersion: 1, kind: 'message/export', complete: page.complete, asOf: page.asOf, nextCursor: page.nextCursor }),
    ...page.items.map(item => canonicalJson({ schemaVersion: 1, kind: 'message/status', complete: page.complete, item }))].join('\n') + '\n'
}

/** Count unique confirmed sessions, including children without double counting a residency.
 * @param snapshot - A freshly observed lifecycle projection.
 * @returns Number of unique sessions with a live, unfinished run.
 */
export function runningSessions(snapshot: LedgerSnapshot): number {
  return new Set(snapshot.rows.flatMap(row => row.kind === 'run' && !row.finish && row.liveness === 'confirmed' ? [row.start.sessionId] : [])).size
}
