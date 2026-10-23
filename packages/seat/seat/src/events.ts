/** Version-one engine facts are isolated from Session and message-ledger event maps. */
import type { Branded } from '@panedesk/dsh-brand'
import type { SessionId } from '@panedesk/dsh-session'
import type { GateContext, GateDefinition, GateResult } from './gates.ts'
import type {
  ChildAdmissionTicket, ClosePhase, CloseReportId, CloseSelfReport, EngineMode,
  HandoverPermit, OpenConfigurationStage, OpenIntentId, OpenPhase, PendingSeatItem,
  ReplacePhase, ReplacementId, ResourceRelease, ResourceReservation, SeatBinding,
  SeatBudgetSnapshot, SeatCallbackDelivery, SeatDigest, SeatFailure, SeatName,
  SeatNodeId, SeatOperationId, SeatPrincipalId, SeatProjectPolicy, SeatSourceId,
  SeatTaskId, SeatTimestamp, SeatWait, SourceEventId, TriggerDeduplication,
  TriggerEnvelope, TriggerId, WaitObservation, WindowEndReason,
} from './types.ts'

/** Separate namespace prevents older readers from consuming engine frames as Session records. */
export const SEAT_ENGINE_NAMESPACE = 'ledger/engine/v1' as const
/** Engine framing version is independent of Core Session format constants. */
export const SEAT_ENGINE_SCHEMA_VERSION = 1 as const
/** Durable decision identity survives replay without duplicating effects. */
export type EngineDecisionId = Branded<'SeatEngineDecisionId'>
/** Durable fact identity used for export deduplication and causal links. */
export type EngineEventId = Branded<'SeatEngineEventId'>
/** Open facts retain the fixed Session identity and each committed configuration stage. */
export interface EngineOpenData {
  /** Frozen configuration and source associations survive catalog edits and queue removal. */
  definition?: import('./types.ts').SeatDefinition
  sources?: readonly TriggerEnvelope[]
  title?: string
  /** Resolved once before creation; recovery never rereads the template source. */
  frozenOpening?: { text: string; digest: SeatDigest; variables: { seat: SeatName; date: string; taskId: SeatTaskId | null } }
  /** Omission preserves automatic engine opening. */
  openingMode?: 'auto' | 'prefill'
  intentId: OpenIntentId
  sessionId: SessionId
  seatRevision: number
  phase: OpenPhase
  completedStages: readonly OpenConfigurationStage[]
  binding: SeatBinding
  openingOperationId: SeatOperationId
  openingMessageId: Branded<'MessageId'> | null
  openingDigest: SeatDigest
  budget: SeatBudgetSnapshot
  failure: SeatFailure | null
}
/** Close facts publish only after archive, title and flush complete. */
export interface EngineCloseData {
  /** Original close identity permits recovery without admitting another archive. */
  operationId?: SeatOperationId
  /** True only after a failed pre-archive operation releases its local barrier. */
  barrierReleased?: boolean
  sessionId: SessionId
  phase: ClosePhase
  reason: WindowEndReason
  stateVersion: number
  endedAt: SeatTimestamp | null
  reportId: CloseReportId | null
  selfReport: CloseSelfReport | null
  selfReportStatus: 'submitted' | 'not-submitted' | 'revoked'
}
/** Replacement observations preserve both windows throughout cleanup and recovery. */
export interface EngineReplacementData {
  /** Caller identity supports recovery and duplicate replacement requests. */
  operationId?: SeatOperationId
  /** Confirmed cleanup distinguishes an absent reservation from a flushed window. */
  cleanup?: 'not-created' | 'closed' | 'pending'
  replacementId: ReplacementId
  oldSessionId: SessionId
  newSessionId: SessionId | null
  phase: ReplacePhase
  permit: HandoverPermit | null
  openingMessageId: Branded<'MessageId'> | null
  firstTurn: { messageId: Branded<'MessageId'>; turnId: string; completed: boolean; hasAssistantReply: boolean } | null
  pending: PendingSeatItem | null
  failure: SeatFailure | null
}
/** Source facts retain deduplication and coalescing associations without credentials. */
export interface EngineTriggerData {
  trigger: TriggerEnvelope
  deduplication: TriggerDeduplication
  pending: PendingSeatItem
  originalTriggerId: TriggerId | null
}
/** Approval reminders identify one queue transition without retaining opening text. */
export interface EngineReminderData {
  queueItemId: PendingSeatItem['queueItemId']
  seat: SeatName
  projectId: PendingSeatItem['projectId']
  triggerKind: PendingSeatItem['triggerKind']
  reason: 'approval'
  triggerId: TriggerId
  sequence: number
  /** Queue revision at entry into approval, not later coalescing revisions. */
  stateVersion: number
  remindedAt: SeatTimestamp
}
/** Gate facts have a stable invocation identity, count and expiration revision. */
export interface EngineGateData { definition: GateDefinition; context: GateContext; result: GateResult }
/** Job recovery distinguishes owner loss from a successfully completed external side effect. */
export interface EngineJobData { sessionId: SessionId; ownerEpoch: import('./types.ts').OwnerEpoch; phase: 'intent' | 'running' | 'settled'; observation: WaitObservation }
/** Memory audit cannot attribute concurrent external changes to the current Session. */
export interface EngineMemoryAuditData { sessionId: SessionId; paths: readonly { path: string; before: SeatDigest | null; after: SeatDigest | null }[]; attribution: 'authorized' | 'unauthorized' | 'unknown'; complete: boolean; reason: string | null }
/** Cache maintenance attempts never append conversation content. */
export interface EngineKeepAliveData {
  sessionId: SessionId
  operationId: SeatOperationId
  source: 'auto' | 'manual'
  phase: 'attempted' | 'renewed' | 'uncertain' | 'skipped'
  reason: string | null
  evidenceAt: number | null
  dueAt: number | null
  observedAt: SeatTimestamp
}
/** Ref position and accepted ingress share a journal decision. */
export interface EngineGitCheckpoint {
  repositoryId: string
  ref: string
  objectId: string | null
  sequence: number
}
/** Closed ledger map: adding a durable kind requires an explicit reader and schema review. */
export interface EngineEventDataMap {
  'cache/keepalive': EngineKeepAliveData
  'cache/keepalive-skipped': EngineKeepAliveData
  'git/checkpoint': EngineGitCheckpoint
  'trigger/accepted': EngineTriggerData
  'trigger/deduplicated': EngineTriggerData
  'trigger/coalesced': EngineTriggerData
  'queue/reminded': EngineReminderData
  'queue/pending': PendingSeatItem
  'queue/approved': { pending: PendingSeatItem; principalId: SeatPrincipalId; previousRevision: number; revision: number }
  'queue/cancelled': { pending: PendingSeatItem; principalId: SeatPrincipalId; previousRevision: number; revision: number }
  'open/intent': EngineOpenData
  'open/created': EngineOpenData
  'open/configured': EngineOpenData
  'open/opening-failed': EngineOpenData
  'open/rejected': { error: SeatFailure; candidates: readonly import('./types.ts').SeatWindowCandidate[] }
  'source/rejected': { sourceId: SeatSourceId; sourceEventId: SourceEventId | null; digest: SeatDigest; error: SeatFailure }
  'seat/binding': SeatBinding
  'window/closing': EngineCloseData
  'window/closed': EngineCloseData
  'window/replacement': EngineReplacementData
  'callback/pending': SeatCallbackDelivery
  'callback/attempted': SeatCallbackDelivery
  'callback/delivered': SeatCallbackDelivery
  'gate/hit': EngineGateData
  'gate/expired': { definition: GateDefinition; hitCount: number; expiredAt: SeatTimestamp }
  'budget/warning': SeatBudgetSnapshot
  'budget/stopped': SeatBudgetSnapshot
  'budget/reconfigured': { budget: SeatBudgetSnapshot; previousRevision: number; authorizationRef: import('./types.ts').AuthorizationRef }
  'wait/registered': SeatWait
  'wait/satisfied': SeatWait
  'wait/woken': SeatWait
  'wait/cancelled': SeatWait
  'child/queued': ChildAdmissionTicket
  'child/admitted': ChildAdmissionTicket
  'child/released': ChildAdmissionTicket
  'job/observed': EngineJobData
  'resource/reserved': ResourceReservation
  'resource/released': ResourceRelease
  'mode/changed': { policy: SeatProjectPolicy; previousMode: EngineMode; previousRevision: number; principalId: SeatPrincipalId }
  'memory/audit': EngineMemoryAuditData
  'report/submitted': { report: CloseSelfReport; principalId: SeatPrincipalId; toolCallId?: Branded<'ToolCallId'>; rootCallId?: Branded<'ToolCallId'> }
  'report/revoked': { reportId: CloseReportId; sessionId: SessionId; stateVersion: number; principalId: SeatPrincipalId }
}
/** Engine kinds never extend the upstream SessionEventMap or LedgerEventKind. */
export type EngineEventKind = keyof EngineEventDataMap
/** Shared causal metadata; each payload carries the fields required by its discriminator. */
export interface EngineEffectBase {
  eventId: EngineEventId
  seat?: SeatName
  sessionId?: SessionId
  taskId?: SeatTaskId
  triggerId?: TriggerId
  operationId?: SeatOperationId
  causedBy?: EngineEventId
}
/** Mapped union preserves the relation between kind and payload when narrowed. */
export type EngineEffect = { [K in EngineEventKind]: EngineEffectBase & { kind: K; data: EngineEventDataMap[K] } }[EngineEventKind]
/** One bounded canonical frame atomically commits all resource, queue and outbox effects. */
export interface EngineDecision {
  namespace: typeof SEAT_ENGINE_NAMESPACE
  schemaVersion: 1
  decisionId: EngineDecisionId
  sequence: number
  observedAt: SeatTimestamp
  nodeId: SeatNodeId
  policyRevision: number
  effects: readonly EngineEffect[]
  digest: SeatDigest
  byteLength: number
}

/** Exhaustive decoder name table; unknown names require explicit version negotiation. */
export const SEAT_ENGINE_EVENT_NAMES = {
  'cache/keepalive': true, 'cache/keepalive-skipped': true, 'git/checkpoint': true,
  'trigger/accepted': true, 'trigger/deduplicated': true, 'trigger/coalesced': true,
  'queue/reminded': true,
  'queue/pending': true, 'queue/approved': true, 'queue/cancelled': true,
  'open/intent': true, 'open/created': true, 'open/configured': true,
  'open/opening-failed': true, 'open/rejected': true, 'source/rejected': true,
  'seat/binding': true, 'window/closing': true, 'window/closed': true,
  'window/replacement': true, 'callback/pending': true, 'callback/attempted': true,
  'callback/delivered': true, 'gate/hit': true, 'gate/expired': true,
  'budget/warning': true, 'budget/stopped': true, 'budget/reconfigured': true,
  'wait/registered': true, 'wait/satisfied': true, 'wait/woken': true,
  'wait/cancelled': true, 'child/queued': true, 'child/admitted': true,
  'child/released': true, 'job/observed': true, 'resource/reserved': true,
  'resource/released': true, 'mode/changed': true, 'memory/audit': true,
  'report/submitted': true, 'report/revoked': true,
} as const satisfies Record<EngineEventKind, true>

declare module '@panedesk/cordis' {
  interface Events {
    /** Published only after a decision is durable; observer failure cannot undo the commit.
     * @mode parallel
     * @param decision - committed frame and its complete effects.
     */
    'seat/decision'(decision: EngineDecision): void
    /** Runtime readiness starts the host-recovery resource-release timing interval.
     * @mode parallel
     * @param status - local node state, including the ready timestamp.
     */
    'seat/ready'(status: import('./types.ts').SeatNodeStatus): void
  }
}
