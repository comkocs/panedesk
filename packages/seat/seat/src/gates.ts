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
  /** Child-owned evidence supplied by the actual continuation executor, never model arguments. */
  continuationEvidence?: {
    cache: import('./types.ts').SeatCacheEvidence
    context: import('./types.ts').SeatContextUsage
    thresholdTokens: number
  }
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
