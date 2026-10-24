/** Shared policy declarations; evaluation and durable counters belong to providers. */
import type { Branded } from '@panedesk/dsh-brand'
import type { SessionId } from '@panedesk/dsh-session'
import type { SeatFailure, SeatJson, SeatName, SeatNodeId, SeatOperationId, SeatTimestamp } from './types.ts'

/** The seven semantic policy hooks are not names of upstream Cordis events. */
export const SEAT_GATE_HOOKS = [
  'before-open', 'before-batch-open', 'before-memory-write', 'before-tool-call',
  'before-subagent-dispatch', 'after-subagent-return', 'after-compaction',
] as const
/** Hook identity shared by configuration, runtime evaluation and ledger queries. */
export type GateHook = typeof SEAT_GATE_HOOKS[number]
/** Stable configured policy identity. */
export type GateId = Branded<'SeatGateId'>
/** Registered criterion identity; JSON never supplies executable JavaScript. */
export type GateCriterionId = Branded<'SeatGateCriterionId'>
/** Complete policy row; counters are deliberately excluded from editable configuration. */
export interface GateDefinition {
  id: GateId
  name: string
  hook: GateHook
  criterion: { type: GateCriterionId; parameters: Readonly<Record<string, SeatJson>> }
  alternative: string
  expiresAt: SeatTimestamp | null
  enabled: boolean
  revision: number
  order: number
}
/** Trusted evaluation identity; repeated call IDs cannot increment a counter twice. */
export interface GateContextBase {
  callId: Branded<'SeatGateCallId'>
  operationId: SeatOperationId
  nodeId: SeatNodeId
  seat: SeatName | null
  sessionId: SessionId | null
  observedAt: SeatTimestamp
  /** Canonical executor directory; absent means relative targets cannot be classified. */
  cwd?: string
  /** Trusted worktree observations supplied by the operation owner, never tool JSON. */
  worktreeFacts?: {
    event: 'register' | 'task-ended' | 'mature'
    clientTreeCount: number
    clientTreeLimit: number
    requestedKind: 'light' | 'client'
    authorizedForce: boolean
    alternative: string
    mature: boolean
  }
  /** Child-owned evidence supplied by the actual continuation executor, never model arguments. */
  continuationEvidence?: {
    cache: import('./types.ts').SeatCacheEvidence
    context: import('./types.ts').SeatContextUsage
    thresholdTokens: number
  }
}
/** Threshold notification facts come from the child context meter. */
export interface SeatChildThresholdRequest {
  sessionId: SessionId
  thresholdRevision: number
  thresholdTokens: number
  context: import('./types.ts').SeatContextUsage
  handoff: string
}
/** Message delivery owns durable idempotency and maps steer to the existing next-step lane. */
export interface SeatReminderHost {
  /** Submit an idempotent reminder to the existing next-step lane.
   * @param request - Target Session, stable delivery identity and reminder content.
   * @returns Durable acceptance or refusal without claiming model completion.
   */
  send(request: { sessionId: SessionId; id: string; kind: 'steer'; content: string }): Promise<'accepted' | 'rejected'>
}
/** Durable worktree owner supplies authoritative records and authorization to policy. */
export interface SeatWorktreeHost {
  /** Read one complete revision; partial catalogs must reject.
   * @returns The complete catalog and its comparison revision.
   */
  read(): Promise<{ revision: number; trees: readonly import('./types.ts').SeatWorktreeRegistration[] }>
  /** Atomically persist registration plus force audit before acknowledging success.
   * @param request - Registration and independent force authorization reference.
   * @param expectedRevision - Catalog revision observed by the caller.
   * @returns Committed registration or a revision conflict without mutation.
   */
  commit(request: import('./types.ts').RegisterSeatWorktreeRequest, expectedRevision: number): Promise<'committed' | 'conflict'>
  /** Resolve repository identity and read-only Git evidence, including recorded activity.
   * @param tree - Registered worktree to inspect without changing its contents.
   * @returns Verified identity, merge and tracked-file state, and last activity time.
   */
  inspect(tree: import('./types.ts').SeatWorktreeRegistration): Promise<{
    verified: boolean
    merged: boolean
    trackedClean: boolean
    lastChangedAt: number | null
  }>
  /** Validate the authorization reference against the caller, never model prose.
   * @param request - Registration containing the caller authorization reference.
   * @returns Whether independent authorization permits the request.
   */
  authorize(request: import('./types.ts').RegisterSeatWorktreeRequest): Promise<boolean>
}
/** Each hook carries facts from its actual execution point rather than model claims. */
export type GateContext = GateContextBase & (
  | { hook: 'before-open'; cwd: string; candidateSeats: readonly SeatName[] }
  | { hook: 'before-batch-open'; seats: readonly SeatName[] }
  | { hook: 'before-memory-write'; targetPath: string; authorizedDirectories: readonly string[]; syntax: 'certain' | 'unknown' }
  | { hook: 'before-tool-call'; toolName: string; arguments: Readonly<Record<string, SeatJson>>; hasPendingWork: boolean }
  | { hook: 'before-subagent-dispatch'; parentSessionId: SessionId; kind: 'start' | 'continue'; childSessionId: SessionId | null; request: Readonly<Record<string, SeatJson>> }
  | { hook: 'after-subagent-return'; parentSessionId: SessionId; childSessionId: SessionId; result: SeatJson }
  | { hook: 'after-compaction'; summary: string; additionalTokenBudget: number; seatRevision: number }
)
/** Opt-in task-aware batch input; absence of a provider preserves legacy seats-only evaluation. */
export type TaskScopeBatchGateContext = Extract<GateContext, { hook: 'before-batch-open' }> & {
  tasks: readonly import('./types.ts').SeatTaskScopeContext[]
}
/** Unknown scope denies concurrent admission and offers serial completion instead. */
export type TaskScopeGateDecision =
  | { outcome: 'allow'; revisions: readonly { taskId: import('./types.ts').SeatTaskId; revision: string }[] }
  | { outcome: 'deny'; reason: 'scope-unknown' | 'scope-conflict' | 'scope-stale'; alternative: 'serial'; conflicts: readonly { tasks: readonly import('./types.ts').SeatTaskId[]; repositoryId?: import('./types.ts').TaskRepositoryId; paths: readonly string[] }[] }

/** Recorded decision metadata, with explicit audit failure independent of deny behavior. */
export interface GateResultFacts {
  gateId: GateId
  revision: number
  hitCount: number
  expiresAt: SeatTimestamp | null
  audit: 'recorded' | 'unavailable'
}
/** Observations cannot reverse completed subagent settlement or block resource release. */
export type GateResult =
  | ({ outcome: 'allow' } & GateResultFacts)
  | ({ outcome: 'deny'; reason: SeatFailure; alternative: string } & GateResultFacts)
  | ({ outcome: 'observe'; reason: string; alternative: string } & GateResultFacts)
/** A durable counter belongs to one gate revision; expiry is emitted once per revision. */
export interface GateSnapshot {
  definition: GateDefinition
  hitCount: number
  expired: boolean
  lastHitAt: SeatTimestamp | null
  watermark: number
}
/** Read-only limit evidence is unknown unless the journal records both operands. */
export interface SeatGateQuerySnapshot extends GateSnapshot {
  limit: { status: 'unknown' | 'below' | 'reached'; value: number | null; observed: number | null }
}
/** Only revisions present in committed gate facts are included, not unobserved configuration. */
export interface SeatGatesQueryResult {
  gates: readonly SeatGateQuerySnapshot[]
  complete: boolean
  watermark: number
  nextCursor?: import('./types.ts').EngineCursor
}

/** Registered evaluators are installed code, not expressions loaded from source payloads. */
export interface GateCriterion {
  id: GateCriterionId
  /** Evaluate one trusted call without writing counters independently.
   * @param context - facts from the owning executor.
   * @param definition - validated criterion parameters and expiration.
   * @returns the policy decision; the registry owns audit publication.
   */
  evaluate(context: GateContext, definition: GateDefinition): Promise<GateResult>
}
