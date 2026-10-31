/**
 * Pure ledger projections for the subagent tree: session parent-child facts,
 * per-node monitoring columns, and nested-tree assembly. No transport, no
 * host service state; callers pass a snapshot and receive values.
 *
 * @module @panedesk/dsh-client-ui-subagent-tree/tree
 */

import type { SessionId } from '@panedesk/dsh-session/types'
import type { LedgerRow, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import type {
  SubagentEndReason,
  SubagentLiveness,
  SubagentNodeStatus,
  SubagentTreeNode,
  SubagentTokenColumns,
} from './types.ts'

/** Ledger-derived monitoring facts for one session, before transcript reads. */
export interface SubagentSessionFacts {
  /** The session these facts describe. */
  readonly sessionId: SessionId
  /** Direct parent session; `null` only for the requested root. */
  readonly parentSessionId: SessionId | null
  /** Monitoring state from lifecycle and wait facts. */
  readonly status: SubagentNodeStatus
  /** Latest process-liveness observation carried by the ledger. */
  readonly liveness: SubagentLiveness
  /** Terminal cause; present only while `status` is `finished`. */
  readonly endReason?: SubagentEndReason | undefined
  /** Five token columns over the session's calls; unobserved columns stay `null`. */
  readonly tokens: SubagentTokenColumns
  /** Coverage of the usage evidence behind `tokens`. */
  readonly usageState: 'missing' | 'partial' | 'complete'
  /** Cache-read share of billed input; `null` when the denominator is unobserved. */
  readonly cacheHitRate: number | null
  /** Latest residency duration in milliseconds; `null` without a run start. */
  readonly elapsedMs: number | null
  /** Run residencies the ledger recorded for this session. */
  readonly runs: number
  /** Model calls attributed to this session. */
  readonly calls: number
  /** Seat identity of the latest attributed row; `null` when no row carries one. */
  readonly seat: string | null
  /** Linked task id of the latest attributed row; `null` when absent. */
  readonly taskId: string | null
}

/** Transcript facts one node contributes; see {@link foldTranscriptFacts}. */
export interface SubagentTranscriptFacts {
  /** Model id from the session's own assistant messages; `null` stays unknown. */
  readonly model: string | null
  /** Why `model` is absent, when it is. */
  readonly modelSource: 'transcript' | 'unavailable' | 'unreadable'
  /** Most recent tool invocation in the session's own suffix; `null` when none. */
  readonly lastToolCall: { readonly name: string; readonly time: number } | null
}

/** Per-session running fold over ledger rows; ledger row order is the observation order. */
interface SessionAccumulator {
  sessionId: SessionId
  parentSessionId: SessionId | null
  runs: number
  calls: number
  waitOpens: number
  waitCloses: number
  liveness: SubagentLiveness
  latestRunStartedAt: number | null
  latestRunEndedAt: number | null
  endReason: SubagentEndReason | undefined
  seat: string | null
  taskId: string | null
  usageObserved: number
  usageMissing: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteShortTokens: number
  cacheWriteShortKnown: boolean
  cacheWriteLongTokens: number
  untieredWrites: number
  outputTokens: number
}

function accumulator(sessionId: SessionId, parentSessionId: SessionId | null): SessionAccumulator {
  return {
    sessionId, parentSessionId,
    runs: 0, calls: 0, waitOpens: 0, waitCloses: 0, liveness: 'unknown',
    latestRunStartedAt: null, latestRunEndedAt: null, endReason: undefined,
    seat: null, taskId: null,
    usageObserved: 0, usageMissing: 0,
    inputTokens: 0, cacheReadTokens: 0, cacheWriteShortTokens: 0, cacheWriteShortKnown: false,
    cacheWriteLongTokens: 0, untieredWrites: 0, outputTokens: 0,
  }
}

/** Context identity is observed in ledger row order; the latest row wins. */
function observeContext(session: SessionAccumulator, seat: string, taskId: string | undefined): void {
  session.seat = seat
  session.taskId = taskId ?? null
}

function observeLifecycle(session: SessionAccumulator, row: Extract<LedgerRow, { kind: 'run' }>): void {
  session.runs += 1
  if (session.latestRunStartedAt === null || row.start.startedAt >= session.latestRunStartedAt) {
    session.latestRunStartedAt = row.start.startedAt
    session.latestRunEndedAt = row.finish?.endedAt ?? null
    session.endReason = row.finish?.endReason
  }
  if (row.liveness !== 'unknown') session.liveness = row.liveness
  observeContext(session, row.start.seat, row.start.taskId)
}

function observeUsage(session: SessionAccumulator, row: Extract<LedgerRow, { kind: 'call' }>): void {
  session.calls += 1
  const finish = row.finish
  if (finish === undefined || finish.usage === undefined) {
    session.usageMissing += 1
    return
  }
  session.usageObserved += 1
  const usage = finish.usage
  session.inputTokens += usage.inputTokens
  session.cacheReadTokens += usage.cacheReadTokens ?? 0
  session.outputTokens += usage.outputTokens
  session.cacheWriteLongTokens += usage.cacheWriteLongTokens ?? 0
  const tiering = (finish.cacheWriteTiering ?? row.start.cacheWriteTiering).kind
  if (tiering === 'tiered') {
    session.cacheWriteShortKnown = true
    session.cacheWriteShortTokens += (usage.cacheWriteTokens ?? 0) - (usage.cacheWriteLongTokens ?? 0)
  } else if (usage.cacheWriteTokens !== undefined) {
    session.untieredWrites += usage.cacheWriteTokens
  }
  observeContext(session, row.start.seat, row.start.taskId)
}

function factsOf(session: SessionAccumulator, asOf: number): SubagentSessionFacts {
  const anyUsage = session.usageObserved > 0
  const tokens: SubagentTokenColumns = {
    inputTokens: anyUsage ? session.inputTokens : null,
    cacheReadTokens: anyUsage ? session.cacheReadTokens : null,
    cacheWriteShortTokens: session.cacheWriteShortKnown ? session.cacheWriteShortTokens : null,
    cacheWriteLongTokens: session.cacheWriteShortKnown ? session.cacheWriteLongTokens : null,
    outputTokens: anyUsage ? session.outputTokens : null,
    cacheWriteTokens: session.untieredWrites > 0 ? session.untieredWrites : null,
  }
  const usageState = session.calls === 0 || !anyUsage
    ? 'missing'
    : session.usageMissing > 0 ? 'partial' : 'complete'
  const writeSide = (session.cacheWriteShortKnown
    ? session.cacheWriteShortTokens + session.cacheWriteLongTokens
    : 0) + session.untieredWrites
  const denominator = session.inputTokens + session.cacheReadTokens + writeSide
  const cacheHitRate = denominator > 0 ? session.cacheReadTokens / denominator : null
  const finished = session.endReason !== undefined
  const status: SubagentNodeStatus = finished ? 'finished' : session.waitOpens > session.waitCloses ? 'waiting' : 'running'
  const elapsedMs = session.latestRunStartedAt === null
    ? null
    : (session.latestRunEndedAt ?? asOf) - session.latestRunStartedAt
  return {
    sessionId: session.sessionId,
    parentSessionId: session.parentSessionId,
    status,
    liveness: session.liveness,
    ...(finished ? { endReason: session.endReason } : {}),
    tokens,
    usageState,
    cacheHitRate,
    elapsedMs,
    runs: session.runs,
    calls: session.calls,
    seat: session.seat,
    taskId: session.taskId,
  }
}

/**
 * Project ledger rows onto per-session monitoring facts for one root's tree.
 *
 * Membership follows ledger parent-child facts: a session joins the tree when
 * its `parentSessionId` chain reaches the root. A parent cycle degrades to
 * excluding the session rather than looping. Rows iterate in snapshot order;
 * that order is the observation order for identity and liveness columns.
 * @param snapshot - deduplicated ledger snapshot to read.
 * @param rootSessionId - session whose descendants form the tree.
 * @param asOf - observation instant standing in for absent run ends.
 * @returns facts for the root and every reachable descendant, in first-observed ledger order;
 * the root is always present, even without ledger rows.
 */
export function subagentTreeSessions(
  snapshot: LedgerSnapshot,
  rootSessionId: SessionId,
  asOf: number,
): readonly SubagentSessionFacts[] {
  const parentBySession = new Map<SessionId, SessionId>()
  for (const row of snapshot.rows) {
    if (row.kind === 'event') continue
    const { sessionId, parentSessionId } = row.start
    if (parentSessionId !== undefined && sessionId !== parentSessionId) {
      parentBySession.set(sessionId, parentSessionId)
    }
  }
  const reachesRoot = (sessionId: SessionId): boolean => {
    const seen = new Set<SessionId>()
    let current: SessionId | undefined = sessionId
    while (current !== undefined && !seen.has(current)) {
      if (current === rootSessionId) return true
      seen.add(current)
      current = parentBySession.get(current)
    }
    return false
  }
  const bySession = new Map<SessionId, SessionAccumulator>()
  const order: SessionId[] = []
  const fold = (sessionId: SessionId): SessionAccumulator => {
    let session = bySession.get(sessionId)
    if (session === undefined) {
      session = accumulator(sessionId, sessionId === rootSessionId ? null : parentBySession.get(sessionId) ?? null)
      bySession.set(sessionId, session)
      order.push(sessionId)
    }
    return session
  }
  fold(rootSessionId)
  for (const row of snapshot.rows) {
    if (row.kind === 'event') {
      if (!reachesRoot(row.event.sessionId)) continue
      const session = fold(row.event.sessionId)
      if (row.event.kind === 'wait/start') session.waitOpens += 1
      else if (row.event.kind === 'wait/end') session.waitCloses += 1
      else if (row.event.kind === 'process/observed' && row.event.liveness !== 'unknown') {
        session.liveness = row.event.liveness
      }
      continue
    }
    if (!reachesRoot(row.start.sessionId)) continue
    const session = fold(row.start.sessionId)
    if (row.kind === 'run') observeLifecycle(session, row)
    else observeUsage(session, row)
  }
  return order.flatMap((sessionId) => {
    const session = bySession.get(sessionId)
    return session === undefined ? [] : [factsOf(session, asOf)]
  })
}

/**
 * Assemble the nested tree view from ledger facts and per-session transcript reads.
 * @param facts - per-session facts from {@link subagentTreeSessions}.
 * @param transcripts - transcript facts keyed by session; a missing entry reads as unknown.
 * @param rootSessionId - session whose node becomes the root.
 * @returns the root node with children in first-observed order, or `null` when the root has no facts.
 */
export function assembleSubagentTree(
  facts: readonly SubagentSessionFacts[],
  transcripts: ReadonlyMap<SessionId, SubagentTranscriptFacts>,
  rootSessionId: SessionId,
): SubagentTreeNode | null {
  const bySession = new Map<SessionId, SubagentTreeNode & { children: SubagentTreeNode[] }>()
  for (const fact of facts) {
    const transcript = transcripts.get(fact.sessionId)
    bySession.set(fact.sessionId, {
      sessionId: fact.sessionId,
      parentSessionId: fact.parentSessionId,
      children: [],
      status: fact.status,
      liveness: fact.liveness,
      ...(fact.endReason !== undefined ? { endReason: fact.endReason } : {}),
      model: transcript?.model ?? null,
      modelSource: transcript?.modelSource ?? 'unavailable',
      tokens: fact.tokens,
      usageState: fact.usageState,
      cacheHitRate: fact.cacheHitRate,
      elapsedMs: fact.elapsedMs,
      runs: fact.runs,
      calls: fact.calls,
      lastToolCall: transcript?.lastToolCall ?? null,
      seat: fact.seat,
      taskId: fact.taskId,
    })
  }
  let root: SubagentTreeNode | null = null
  for (const fact of facts) {
    const node = bySession.get(fact.sessionId)
    if (node === undefined) continue
    const parent = fact.parentSessionId === null ? undefined : bySession.get(fact.parentSessionId)
    if (parent === undefined) {
      if (root === null) root = node
    } else {
      parent.children.push(node)
    }
  }
  return bySession.get(rootSessionId) ?? root
}
