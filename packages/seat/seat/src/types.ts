/** Shared seat declarations; durable records belong to the engine, never the Session event union. */
import type { Branded } from '@panedesk/dsh-brand'
import type { SessionId } from '@panedesk/dsh-session'
import type { EngineDecision, EngineEffect, EngineEventKind } from './events.ts'
import type { GateDefinition, GateHook, GateSnapshot } from './gates.ts'

/** Node-local definition key; display names are preserved by import. */
export type SeatName = Branded<'SeatName'>
/** Project policy identity, not a directory identity. */
export type SeatProjectId = Branded<'SeatProjectId'>
/** Persistent node identity, independent of network location. */
export type SeatNodeId = Branded<'LedgerNodeId'>
/** Caller-stable operation identity; different payloads must conflict. */
export type SeatOperationId = Branded<'SeatOperationId'>
/** Stable source registration identity; never a callback address. */
export type SeatSourceId = Branded<'SeatSourceId'>
/** Authenticated source event identity. */
export type SourceEventId = Branded<'SeatSourceEventId'>
/** Engine-assigned trigger identity. */
export type TriggerId = Branded<'SeatTriggerId'>
/** Durable FIFO queue identity. */
export type QueueItemId = Branded<'SeatQueueItemId'>
/** Fixed open intent identity retained across recovery. */
export type OpenIntentId = Branded<'SeatOpenIntentId'>
/** Replacement transaction identity. */
export type ReplacementId = Branded<'SeatReplacementId'>
/** Single-transaction handover capability identity. */
export type HandoverPermitId = Branded<'SeatHandoverPermitId'>
/** Callback deduplication identity retained across delivery attempts. */
export type CallbackId = Branded<'SeatCallbackId'>
/** Persisted wait identity. */
export type WaitId = Branded<'SeatWaitId'>
/** Nonblocking child admission ticket identity. */
export type ChildTicketId = Branded<'SeatChildTicketId'>
/** Structured close report identity. */
export type CloseReportId = Branded<'SeatCloseReportId'>
/** Import preview identity, bound to source and catalog revision. */
export type SeatImportPlanId = Branded<'SeatImportPlanId'>
/** Rule identity unique within one definition. */
export type SeatRuleId = Branded<'SeatRuleId'>
/** Owner residency identity; a fenced epoch cannot resume execution. */
export type OwnerEpoch = Branded<'SeatOwnerEpoch'>
/** Registered task reference, with no embedded task instructions. */
export type SeatTaskId = Branded<'SeatTaskId'>
/** Authenticated principal reference supplied by the service context. */
export type SeatPrincipalId = Branded<'SeatPrincipalId'>
/** Audit reference for an independently authorized policy change. */
export type AuthorizationRef = Branded<'SeatAuthorizationRef'>
/** Digest of canonical bytes; algorithms and framing are owned by the provider. */
export type SeatDigest = Branded<'SeatDigest'>
/** UTC ISO timestamp supplied by the host clock, not by model output. */
export type SeatTimestamp = string
/** JSON-safe data accepted only after bounded parser validation. */
export type SeatJson = null | boolean | number | string | readonly SeatJson[] | { readonly [key: string]: SeatJson }
/** Project policy can only be tightened by an individual rule. */
export type EngineMode = 'off' | 'remind' | 'auto'
/** Import source retains authority until an explicitly authorized takeover. */
export type SeatAuthority = 'import-source' | 'seat-store'
/** Text has one editable owner; references are resolved without copying that owner. */
export type SeatText = { kind: 'text'; text: string } | { kind: 'file'; path: string; section?: string }
/** Exactly one directory in a validated definition is the startup directory. */
export interface SeatDirectory { path: string; startup: boolean }
/** A bounded, uniquely selected checkpoint segment; required content cannot be silently omitted. */
export interface SeatCheckpointFile { path: string; section: string; maxBytes: number; required: boolean }
/** Product-neutral worktree policy; no automatic deletion is implied. */
export interface SeatWorktreePolicy {
  clientTreesPerSlot: number
  staleOnSettle: 'notify'
  lightByDefault: boolean
  staleHours: number
}
/** Integer micro-USD serialized as decimal digits; never accumulate binary floating-point USD. */
export type MicroUsd = Branded<'SeatMicroUsd'>
/** Budget absence is unlimited; unknown cost is never interpreted as zero. */
export interface SeatBudgetLimits { windowBudgetUsd?: MicroUsd; dailyBudgetUsd?: MicroUsd }
/** Automatic admission interval in an explicit IANA time zone, with an exclusive end. */
export interface SeatTimeWindow { timeZone: string; start: string; end: string; weekdays?: readonly number[] }
/** Optional account concurrency is descriptive only; this engine does not enforce it. */
export interface ModelAccountConcurrency { accountLabel: string; limit: number }
/** Three-way import baseline keeps normalized fields and their per-column hashes. */
export interface SeatImportSource {
  sourcePath: string
  sourceFileHash: SeatDigest
  rowHash: SeatDigest
  mappingHash: SeatDigest
  columnHashes: Readonly<Record<string, SeatDigest>>
  baseline: Readonly<Record<string, SeatJson>>
  authority: SeatAuthority
}
/** Validated node-local definition; defaults are frozen by resolve before execution. */
export interface SeatDefinition {
  schemaVersion: 1
  revision: number
  seat: SeatName
  platform: 'desktop' | 'vscode' | 'server'
  node: string
  projectId: SeatProjectId
  directories: readonly SeatDirectory[]
  memoryDirectories: readonly string[]
  opening: SeatText
  openingInstructionFiles: readonly string[]
  agentPreset: string
  provider: string
  model: string
  reasoningEffort: string
  permissionPreset: string
  subscriptions: readonly string[]
  checkpointFiles: readonly SeatCheckpointFile[]
  wakeTemplate?: SeatText
  maxOpenSessions: number
  maxActiveSubagents: number
  contextThresholdTokens?: number
  subagentContextThresholdTokens: number
  rules: readonly SeatRule[]
  /** Present overrides may only tighten the validated node-wide limits. */
  pollingThreshold?: number
  maxSleepSeconds?: number
  worktree: SeatWorktreePolicy
  source?: SeatImportSource
}

/** Six trigger families share durable admission rather than creating Sessions directly. */
export type SeatTrigger =
  | { kind: 'schedule'; selector: SeatScheduleSelector; timeZone: string }
  | { kind: 'git'; repositoryId: string; ref: string }
  | { kind: 'external'; sourceId: SeatSourceId; eventType?: string }
  | { kind: 'window-ended'; seat: SeatName; on: 'closed' | 'can-close' }
  | { kind: 'handoff-timeout'; timeoutMinutes: number }
  | { kind: 'manual'; origin: 'manual' | 'remote' }
/** Schedule recurrence is supplied by the existing scheduler, not a second timer engine. */
export type SeatScheduleSelector = Omit<import('@panedesk/dsh-schedule').ScheduleCreateRequest, 'prompt' | 'title'>
/** Rule policy cannot widen its project's mode. */
export interface SeatRule extends SeatBudgetLimits {
  id: SeatRuleId
  enabled: boolean
  trigger: SeatTrigger
  mode?: EngineMode
  timeWindows: readonly SeatTimeWindow[]
  exclusiveTags: readonly string[]
  modelAccountConcurrency?: readonly ModelAccountConcurrency[]
  timeoutMinutes?: number
}
/** Stable machine failures shared by CLI, SDK and providers. */
export type SeatErrorCode =
  | 'seat-not-found' | 'seat-already-open' | 'seat-choice-required'
  | 'cross-node-unsupported' | 'import-preview-stale' | 'import-conflict'
  | 'import-source-authoritative' | 'seat-store-authoritative'
  | 'invalid-definition' | 'invalid-request' | 'unsupported-schema-version'
  | 'revision-conflict' | 'operation-id-conflict' | 'event-id-conflict'
  | 'unauthorized' | 'unavailable' | 'disabled' | 'engine-store-corrupt'
  | 'session-not-found' | 'session-busy' | 'state-conflict' | 'owner-unknown'
  | 'memory-seat-mismatch' | 'wake-template-missing' | 'batch-explicit-seats-required'
  | 'batch-limit-exceeded' | 'cache-evidence-unavailable' | 'cache-expired'
  | 'cache-prefix-changed' | 'maintenance-busy' | 'renewal-uncertain'
  | 'subagent-renewal-expired' | 'subagent-context-limit' | 'evidence-unavailable'
  | 'polling' | 'sleep-limit-exceeded' | 'gate-denied' | 'audit-unavailable'
  | 'checkpoint-unavailable' | 'checkpoint-changed' | 'checkpoint-budget-exceeded'
  | 'budget-unverifiable' | 'budget-full' | 'budget-stopped'
  | 'source-not-found' | 'source-authentication-failed' | 'source-payload-too-large'
  | 'source-timestamp-invalid' | 'callback-authentication-failed' | 'callback-protocol-error'
  | 'open-create-failed' | 'open-configuration-failed' | 'opening-failed'
  | 'session-id-conflict' | 'replacement-open-failed' | 'replacement-first-turn-failed'
  | 'replacement-cleanup-failed' | 'wait-id-conflict' | 'wait-object-not-found'
  | 'wait-object-unauthorized' | 'ticket-not-found' | 'ticket-cancelled'
  | 'report-not-found' | 'report-revoked' | 'causal-depth-exceeded'
  | 'rule-self-loop' | 'query-cursor-invalid' | 'export-event-conflict'
  | 'worktree-client-limit' | 'worktree-unverified'
/** Safe diagnostic without credentials, signatures, network locations or raw source bodies. */
export interface SeatFailure {
  code: SeatErrorCode
  message: string
  alternative: string
  retryable: boolean
  effectState: 'none' | 'committed' | 'partial' | 'unknown'
}
/** Typed rejection keeps an actionable failure separate from successful results. */
export interface SeatRejected { status: 'rejected'; error: SeatFailure }
/** Authenticated local identity; wire callers cannot promote their origin or principal. */
export interface SeatCallContext { principalId: SeatPrincipalId; origin: 'manual' | 'remote' | 'engine'; nodeId: SeatNodeId }
/** Temporary admission reasons preserve FIFO rather than returning a hard failure. */
export type PendingReason = 'approval' | 'project-off' | 'time-window' | 'node-capacity' | 'seat-capacity' | 'exclusive-tag' | 'budget-full' | 'budget-unverifiable' | 'provider-unavailable'
/** A queued operation owns no exclusive resource until admission commits. */
export interface SeatQueued { status: 'queued'; queueItemId: QueueItemId; sequence: number; reason: PendingReason; blockedBy: readonly string[] }
/** Definition defaults are input only; resolver validates all selected rows independently. */
export interface PreviewSeatImportRequest {
  format: 'markdown' | 'csv'
  sourcePath: string
  columnMap: Readonly<Record<string, string>>
  defaults: Partial<SeatDefinition>
  table?: string
}
/** Three-way field comparison retains manual edits even when both edits happen to match. */
export interface SeatImportDifference { field: string; baseline: SeatJson; local: SeatJson; source: SeatJson; conflict: boolean }
/** Invalid rows start unselected; removed source rows require explicit tombstone selection. */
export interface SeatImportRow {
  row: number
  seat: SeatName | null
  definition: SeatDefinition | null
  rowHash: SeatDigest
  columnHashes: Readonly<Record<string, SeatDigest>>
  action: 'create' | 'update' | 'retain' | 'conflict' | 'tombstone' | 'invalid'
  selected: boolean
  differences: readonly SeatImportDifference[]
  diagnostics: readonly SeatFailure[]
}
/** Preview never changes the catalog and expires when source bytes or catalog revision change. */
export interface SeatImportPlan {
  planId: SeatImportPlanId
  sourceFileHash: SeatDigest
  mappingHash: SeatDigest
  baseRevision: number
  rows: readonly SeatImportRow[]
}
/** Only explicitly selected rows can be committed against the preview's original revision. */
export interface CommitSeatImportRequest {
  planId: SeatImportPlanId
  selectedRows: readonly number[]
  expectedRevision: number
  operationId: SeatOperationId
}
/** Conflicting rows remain unchanged; unaffected rows can be committed independently. */
export type CommitSeatImportResult = { status: 'committed'; revision: number; rows: readonly SeatImportRow[] } | SeatRejected
/** Authorized catalog takeover is explicit and does not follow engine activation. */
export interface SetSeatAuthorityRequest {
  expectedRevision: number
  authority: SeatAuthority
  authorizationRef: AuthorizationRef
  operationId: SeatOperationId
}
/** Catalog writes use compare-and-swap rather than overwriting concurrent edits. */
export interface SaveSeatDefinitionRequest { definition: SeatDefinition; expectedRevision: number; operationId: SeatOperationId }
/** Catalog mutation returns the committed revision, not a speculative local value. */
export type SeatCatalogMutationResult = { status: 'saved'; revision: number } | SeatRejected
/** Node-scoped catalog query; omitted filters include all authorized local definitions. */
export interface ListSeatDefinitionsRequest { nodeId?: SeatNodeId; projectId?: SeatProjectId; cursor?: string }
/** Catalog pagination reports incompleteness explicitly. */
export interface ListSeatDefinitionsResult {
  definitions: readonly SeatDefinition[]
  revision: number
  complete: boolean
  nextCursor?: string
}

/** Existing-window choices never silently bypass the configured active-window limit. */
export type ExistingSeatChoice = { kind: 'switch'; sessionId: SessionId } | { kind: 'replace'; sessionId: SessionId } | { kind: 'cancel' }
/** Origin must match authenticated context; remote and engine opening is always automatic. */
export interface OpenSeatRequest {
  seat: SeatName
  operationId: SeatOperationId
  origin: 'manual' | 'remote' | 'engine'
  nodeId?: SeatNodeId
  taskId?: SeatTaskId
  openingMode?: 'auto' | 'prefill'
  existingChoice?: ExistingSeatChoice
  expectedSeatRevision?: number
}
/** Authorized existing-window candidate, never selected implicitly when several exist. */
export interface SeatWindowCandidate { seat: SeatName; sessionId: SessionId; title: string; nodeId: SeatNodeId }
/** Creation and first-turn success are distinct; created callbacks do not await the model. */
export type OpenPhase = 'intent' | 'creating' | 'created' | 'configuring' | 'opening-pending' | 'active' | 'opening-failed'
/** Configuration stages are persisted independently to avoid overwriting later user changes. */
export type OpenConfigurationStage = 'workspace' | 'model' | 'permission' | 'subscriptions' | 'title' | 'binding' | 'opening'
/** Created window facts remain queryable even if subsequent configuration fails. */
export interface OpenedSeatWindow {
  sessionId: SessionId
  seat: SeatName
  nodeId: SeatNodeId
  nodeName: string
  title: string
  budget: SeatBudgetLimits
  phase: OpenPhase
  stateVersion: number
  callbackIds: readonly CallbackId[]
}
/** Prefill carries a draft without creating a model turn; switching never creates a second window. */
export type OpenSeatResult =
  | ({ status: 'opened' } & OpenedSeatWindow)
  | ({ status: 'prefilled'; draft: string } & OpenedSeatWindow)
  | { status: 'choice-required'; candidates: readonly SeatWindowCandidate[]; choices: readonly ['switch', 'replace', 'cancel']; defaultChoice: 'switch' }
  | { status: 'switched'; window: SeatWindowCandidate }
  | { status: 'cancelled' }
  | SeatQueued | SeatRejected
/** Explicit bounded names only; wildcard and implicit-all forms are rejected before any open. */
export interface OpenSeatBatchRequest { seats: readonly SeatName[]; operationId: SeatOperationId; origin: 'manual' | 'remote'; openingMode?: 'auto' | 'prefill'; nodeId?: SeatNodeId }
/** Per-seat outcomes are independent; batch opening is not an atomic transaction. */
export type OpenSeatBatchResult = { status: 'processed'; results: readonly { seat: SeatName; result: OpenSeatResult }[] } | SeatRejected
/** Runtime-derived display states are not a new upstream Agent state machine. */
export type SeatWindowStatus = 'running' | 'idle' | 'approval-pending' | 'plan-review-pending' | 'answer-pending' | 'completed'
/** Policy overlays do not disguise unavailable runtime evidence as idle. */
export type SeatEngineStatus = 'active' | 'prefilled' | 'budget-stopped' | 'configuring' | 'closing' | 'unknown'
/** Busy evidence survives incomplete snapshots and names the outstanding work. */
export interface SeatBusyReason { kind: 'turn' | 'subagent' | 'job' | 'approval' | 'plan-review' | 'answer' | 'wait' | 'ticket' | 'inbox' | 'owner-unknown'; objectId?: string; summary: string }
/** Idle time and renewability are null/false when cache or runtime evidence is unavailable. */
export interface SeatWindowView extends SeatWindowCandidate {
  status: SeatWindowStatus | null
  engineStatus: SeatEngineStatus
  evidence: 'complete' | 'unknown'
  idleMinutes: number | null
  runningSubagents: number
  activeJobs: number
  canRenew: boolean
  renewRejection: SeatFailure | null
  busyReasons: readonly SeatBusyReason[]
  stateVersion: number
  seatBinding: SeatBinding | null
}
/** Omitted filters include every authorized local window, never another node's live execution. */
export interface ListSeatWindowsRequest { nodeId?: SeatNodeId; projectId?: SeatProjectId; cursor?: string }
/** Incomplete scans carry a cursor rather than pretending the unopened set is complete. */
export type ListSeatWindowsResult = { status: 'listed'; sessions: readonly SeatWindowView[]; unopenedSeats: readonly SeatName[]; snapshotAt: SeatTimestamp; complete: boolean; nextCursor?: string } | SeatRejected
/** One maintenance operation, never a normal conversation input. */
export interface RenewSeatRequest { sessionId: SessionId; operationId: SeatOperationId; nodeId?: SeatNodeId }
/** Unknown evidence forbids retrying a possibly issued network maintenance call. */
export interface SeatCacheEvidence {
  lastActivityAt: SeatTimestamp | null
  cacheTtlMs: number | null
  prefixDigest: SeatDigest | null
  observedAt: SeatTimestamp
  reusableRequest: boolean
}
/** Uncertain renewal is terminal for this operation ID and must not be automatically replayed. */
export type RenewSeatResult = { status: 'renewed'; sessionId: SessionId; cacheEvidence: SeatCacheEvidence } | { status: 'uncertain'; error: SeatFailure; cacheEvidence: SeatCacheEvidence } | (SeatRejected & { cacheEvidence: SeatCacheEvidence })
/** Closing blocks new work before rechecking idle and unsettled work. */
export type ClosePhase = 'admission' | 'rechecking' | 'archiving' | 'renaming' | 'flushing' | 'closed'
/** Budget stopping is not a window end. */
export type WindowEndReason = 'manual' | 'self-report' | 'replaced' | 'owner-dead' | 'replacement-failed'
/** Manual close does not require a self-report, but never force-stops active work. */
export interface CloseSeatRequest { sessionId: SessionId; operationId: SeatOperationId; expectedStateVersion: number; nodeId?: SeatNodeId }
/** Busy and CAS conflicts preserve the window and expose evidence for a safe next action. */
export type CloseSeatResult =
  | { status: 'closed'; sessionId: SessionId; phase: 'closed'; endedAt: SeatTimestamp; stateVersion: number }
  | { status: 'busy'; sessionId: SessionId; busyReasons: readonly SeatBusyReason[] }
  | { status: 'conflict'; expectedStateVersion: number; actualStateVersion: number }
  | SeatRejected
/** Replacement waits FIFO for both-window capacity and never closes old before opening new. */
export type ReplacePhase = 'queued' | 'opening' | 'created' | 'configuring' | 'first-turn-pending' | 'awaiting-old-idle' | 'closing-old' | 'completed' | 'closing-new' | 'failed'
/** Permit authorizes only this handover, not extra capacity or new-window exclusive-tag access. */
export type HandoverPermitState = 'issued' | 'first-turn-running' | 'expired-success' | 'expired-failure'
/** New-window first-turn completion or failure expires the permit; old keeps tags until closed. */
export interface HandoverPermit {
  permitId: HandoverPermitId
  replacementId: ReplacementId
  oldSessionId: SessionId
  newSessionId: SessionId
  state: HandoverPermitState
  issuedAt: SeatTimestamp
  expiredAt: SeatTimestamp | null
  ownerEpoch: OwnerEpoch
}
/** No capacity override is accepted from an external caller. */
export interface ReplaceSeatRequest { sessionId: SessionId; operationId: SeatOperationId; nodeId?: SeatNodeId }
/** Failure cleanup closes the new window while leaving the old window unchanged. */
export type ReplacementFailureCode = 'replacement-open-failed' | 'replacement-first-turn-failed' | 'replacement-cleanup-failed'
/** A replacement remains observable during queueing and failed-window cleanup. */
export type ReplaceSeatResult =
  | { status: 'queued'; replacementId: ReplacementId; oldSessionId: SessionId; phase: 'queued'; queueItemId: QueueItemId; sequence: number; reason: PendingReason }
  | { status: 'replacing'; replacementId: ReplacementId; oldSessionId: SessionId; newSessionId: SessionId; phase: Exclude<ReplacePhase, 'queued' | 'failed'>; permit: HandoverPermit }
  | { status: 'failed'; replacementId: ReplacementId; oldSessionId: SessionId; newSessionId: SessionId | null; phase: 'failed'; reason: ReplacementFailureCode; cause: SeatFailure; cleanup: 'not-created' | 'closed' | 'pending' }
  | SeatRejected

/** Manual rename retains upstream title pinning and changes no seat identity. */
export interface RenameSeatRequest { sessionId: SessionId; title: string; operationId: SeatOperationId; nodeId?: SeatNodeId }
/** Title mutation exposes the upstream committed title. */
export type RenameSeatResult = { status: 'renamed'; sessionId: SessionId; title: import('@panedesk/dsh-session-title/types').SessionTitleSnapshot } | SeatRejected
/** Multiple active windows require an explicit target; an unopened seat delegates to open. */
export interface WakeSeatRequest { seat: SeatName; sessionId?: SessionId; operationId: SeatOperationId; nodeId?: SeatNodeId }
/** Stored mail cannot lift a budget admission barrier. */
export type WakeSeatResult =
  | { status: 'sent' | 'stored-budget-stopped'; sessionId: SessionId; messageId: Branded<'MessageId'>; operationId: SeatOperationId }
  | { status: 'opened'; result: OpenSeatResult }
  | { status: 'choice-required'; candidates: readonly SeatWindowCandidate[] }
  | SeatRejected
/** Persistent metadata is projected beside Session data, never appended as a new Session event. */
export type SeatBinding =
  | { kind: 'free'; sessionId: SessionId; nodeId: SeatNodeId; identitySource: 'free' }
  | {
    kind: 'seat'
    sessionId: SessionId
    seat: SeatName
    projectId: SeatProjectId
    nodeId: SeatNodeId
    bindingSource: 'seat-definition'
    identitySource: 'settings' | 'inherited'
    openOperationId: SeatOperationId
    seatRevision: number
    taskId?: SeatTaskId
    relatedTaskIds: readonly SeatTaskId[]
    directories: readonly SeatDirectory[]
    memoryDirectories: readonly string[]
    subscriptions: readonly string[]
    openingDigest: SeatDigest
  }
/** Traditional-create confirmation is single-use and tied to identity, path and candidate revisions. */
export interface DirectoryConfirmation {
  token: Branded<'SeatDirectoryConfirmation'>
  cwd: string
  principalId: SeatPrincipalId
  candidates: readonly { seat: SeatName; revision: number }[]
  choice: { kind: 'open-seat'; seat: SeatName } | { kind: 'traditional' }
}
/** Canonical directory admission never silently chooses the first matching definition. */
export interface ResolveDirectoryChoiceRequest { cwd: string; seat?: SeatName; confirmation?: DirectoryConfirmation; interactive: boolean }
/** A free admission explicitly prevents inherited startup identity from contaminating the window. */
export type DirectoryChoiceResult = { status: 'allowed'; identity: 'free' | 'seat'; seat?: SeatName } | { status: 'choice-required'; candidates: readonly SeatName[]; choices: readonly ['open-seat', 'traditional', 'cancel']; alternative: string } | SeatRejected
/** Three mandatory self-report fields remain distinct from runtime close eligibility. */
export interface CloseSelfReport {
  reportId: CloseReportId
  sessionId: SessionId
  canClose: boolean
  waitingFor: readonly { kind: 'subagent' | 'job' | 'schedule' | 'message' | 'other'; objectId?: string; summary: string }[]
  nextOpen: { when: { kind: 'unspecified' } | { kind: 'at'; at: SeatTimestamp } | { kind: 'condition'; description: string }; prerequisites: readonly string[] }
  submittedAt: SeatTimestamp
  stateVersion: number
}
/** Trusted tool attribution is optional for SDK reports, which do not create model messages. */
export interface SubmitCloseReportRequest {
  report: CloseSelfReport
  operationId: SeatOperationId
  toolCallId?: Branded<'ToolCallId'>
  rootCallId?: Branded<'ToolCallId'>
}
/** Revocation invalidates a previous automatic-close candidate through CAS. */
export interface RevokeCloseReportRequest {
  reportId: CloseReportId
  sessionId: SessionId
  expectedStateVersion: number
  operationId: SeatOperationId
}
/** Reporting success does not claim that the Session has become idle or closed. */
export type CloseReportResult = { status: 'recorded' | 'revoked'; reportId: CloseReportId; stateVersion: number } | SeatRejected
/** Four observation families share one nonblocking wait registration. */
export type WaitObject =
  | { kind: 'subagent'; id: Branded<'SubagentRunId'> }
  | { kind: 'job'; id: Branded<'JobId'> }
  | { kind: 'schedule'; id: Branded<'ScheduleId'> }
  | { kind: 'message'; id: Branded<'MessageId'> }
/** Registration commits before checking current terminal state and installing subscriptions. */
export interface RegisterSeatWaitRequest { waitId: WaitId; sessionId: SessionId; mode: 'any' | 'all'; objects: readonly WaitObject[]; operationId: SeatOperationId; toolCallId?: Branded<'ToolCallId'>; rootCallId?: Branded<'ToolCallId'> }
/** Unknown owner loss is not a successful task outcome. */
export interface WaitObservation { object: WaitObject; outcome: 'completed' | 'failed' | 'cancelled' | 'owner-lost' | 'unknown'; observedAt: SeatTimestamp; watermark: number; durability: 'durable' | 'best-effort' }
/** Cancellation and wake compete on a single durable state version. */
export interface SeatWait {
  waitId: WaitId
  sessionId: SessionId
  mode: 'any' | 'all'
  objects: readonly WaitObject[]
  observations: readonly WaitObservation[]
  phase: 'registered' | 'satisfied' | 'woken' | 'cancelled'
  operationId: SeatOperationId
  wakeOperationId: SeatOperationId
  toolCallId?: Branded<'ToolCallId'>
  rootCallId?: Branded<'ToolCallId'>
  stateVersion: number
  durability: 'durable' | 'best-effort'
}
/** The tool must conclude its turn after registration rather than awaiting completion. */
export type RegisterSeatWaitResult = { status: 'registered'; wait: SeatWait } | SeatRejected
/** Wait cancellation never cancels the observed tasks themselves. */
export interface CancelSeatWaitRequest { waitId: WaitId; sessionId: SessionId; expectedStateVersion: number; operationId: SeatOperationId }
/** Already-terminal waits return their committed state without a second wake. */
export type CancelSeatWaitResult = { status: 'cancelled' | 'already-settled'; wait: SeatWait } | SeatRejected
/** Admission ticket includes frozen permission evidence; execution rechecks later tightening. */
export interface ChildAdmissionTicket {
  ticketId: ChildTicketId
  parentSessionId: SessionId
  sequence: number
  requestDigest: SeatDigest
  agentPreset: string
  permissionRevision: number
  phase: 'queued' | 'admitted' | 'released' | 'cancelled'
  childSessionId: SessionId | null
  ownerEpoch: OwnerEpoch
  stateVersion: number
}
/** A fifth child returns immediately with a ticket, not a Promise waiting for capacity. */
export type ChildAdmissionResult = { status: 'queued'; ticket: ChildAdmissionTicket } | { status: 'admitted'; ticket: ChildAdmissionTicket; childSessionId: SessionId } | SeatRejected
/** The caller owns cancellation and observation of its admission ticket. */
export interface CancelChildTicketRequest {
  ticketId: ChildTicketId
  parentSessionId: SessionId
  expectedStateVersion: number
  operationId: SeatOperationId
}
/** Cancellation returns the committed ticket and never kills an already running child. */
export type CancelChildTicketResult = { status: 'cancelled' | 'already-admitted'; ticket: ChildAdmissionTicket } | SeatRejected
/** Epoch fencing precedes resource release, including same-host Session destruction. */
export interface ResourceOwner { sessionId: SessionId; intentId: OpenIntentId; ownerEpoch: OwnerEpoch; resourceRevision: number }
/** Labels are reserved atomically; waiting requests have no owner. */
export interface ResourceReservation {
  owner: ResourceOwner
  nodeId: SeatNodeId
  seat: SeatName
  exclusiveTags: readonly string[]
  engineWindowUnits: number
  seatWindowUnits: number
}
/** Recovery timing starts at engine ready, separately from observable holder death. */
export type ResourceReleaseReason = 'window-closed' | 'holder-death' | 'host-restart-recovery' | 'open-aborted' | 'replacement-handover'
/** Both origins retain measurable timestamps for the five-second release obligation. */
export interface ResourceRelease {
  owner: ResourceOwner
  reason: ResourceReleaseReason
  observedAt: SeatTimestamp
  engineReadyAt: SeatTimestamp | null
  releasedAt: SeatTimestamp
  fenced: true
}

/** Typed trigger evidence keeps recovery independent of unstructured source data. */
export type SeatTriggerEvidence =
  | { kind: 'schedule'; scheduleId: Branded<'ScheduleId'>; scheduledAt: SeatTimestamp }
  | { kind: 'git'; repositoryId: Branded<'SeatRepositoryId'>; ref: string; oldObjectId: string | null; newObjectId: string | null; observationSequence: number }
  | { kind: 'external'; eventType: string }
  | { kind: 'window-ended'; sessionId: SessionId; endedEventId: SourceEventId; reportId: CloseReportId | null; origin: 'closed' | 'can-close' }
  | ({ kind: 'handoff-timeout' } & SeatHandoffTimeout)
  | { kind: 'manual'; origin: 'manual' | 'remote'; operationId: SeatOperationId }
/** Timeout actions always target the original sender and reuse one wake operation. */
export interface SeatHandoffTimeout {
  messageId: Branded<'MessageId'>
  senderSessionId: SessionId
  deadlineVersion: number
  deadlineAt: SeatTimestamp
  timeoutMinutes: number
  wakeOperationId: SeatOperationId
}
/** Authenticated ingress; receivedAt and fallback time buckets are computed by the host. */
export interface TriggerEnvelope {
  triggerId: TriggerId
  sourceId: SeatSourceId
  eventId?: SourceEventId
  kind: SeatTrigger['kind']
  evidence: SeatTriggerEvidence
  seat: SeatName
  projectId: SeatProjectId
  receivedAt: SeatTimestamp
  dataDigest: SeatDigest
  data: SeatJson
  taskId?: SeatTaskId
  callbackRef: SeatSourceId
  cause?: { eventId: SourceEventId; depth: number }
}
/** Canonical digest conflicts reject; bucket fallback does not promise cross-bucket deduplication. */
export interface TriggerDeduplication {
  key: string
  digest: SeatDigest
  receivedAt: SeatTimestamp
  bucket: number | null
  sourceId: SeatSourceId
  eventId: SourceEventId | null
}
/** Acceptance is returned only after the complete decision has been durably committed. */
export type AcceptTriggerResult =
  | { status: 'accepted' | 'coalesced'; triggerId: TriggerId; queueItemId: QueueItemId; sequence: number }
  | { status: 'duplicate'; triggerId: TriggerId; originalTriggerId: TriggerId; queueItemId: QueueItemId | null }
  | SeatRejected
/** Coalescing retains every source callback and related task reference. */
export interface PendingSeatItem {
  queueItemId: QueueItemId
  seat: SeatName
  projectId: SeatProjectId
  triggerKind: SeatTrigger['kind']
  action: 'open' | 'wake-sender' | 'replace'
  /** Required for wake-sender; absent for ordinary opens and replacements. */
  handoffTimeout?: SeatHandoffTimeout
  sequence: number
  effectiveMode: EngineMode
  reason: PendingReason
  blockedBy: readonly string[]
  sources: readonly TriggerEnvelope[]
  relatedTaskIds: readonly SeatTaskId[]
  queuedAt: SeatTimestamp
  stateVersion: number
}
/** Project policy defaults to remind with modeChosen false until an explicit selection. */
export interface SeatProjectPolicy { projectId: SeatProjectId; mode: EngineMode; modeChosen: boolean; revision: number }
/** Mode changes recheck already queued work without dropping it. */
export interface SetProjectModeRequest {
  projectId: SeatProjectId
  mode: EngineMode
  expectedRevision: number
  operationId: SeatOperationId
}
/** Mode writes expose their committed policy revision. */
export type SetProjectModeResult = { status: 'saved'; policy: SeatProjectPolicy } | SeatRejected
/** Queue queries expose pending reasons without source instruction bodies. */
export interface ListPendingSeatsRequest { projectId?: SeatProjectId; seat?: SeatName; cursor?: EngineCursor; limit: number }
/** Stable pagination does not stop at the first filtered page. */
export interface ListPendingSeatsResult {
  items: readonly PendingSeatItem[]
  complete: boolean
  watermark: number
  nextCursor?: EngineCursor
}
/** Approval bypasses only remind confirmation, never capacity, time, node or budget checks. */
export interface ApprovePendingSeatRequest { queueItemId: QueueItemId; expectedStateVersion: number; operationId: SeatOperationId }
/** Explicit cancellation retains its audit fact and does not close already created windows. */
export interface CancelPendingSeatRequest { queueItemId: QueueItemId; expectedStateVersion: number; operationId: SeatOperationId }
/** Pending mutation is revision-checked and can settle without creating a window. */
export type PendingSeatMutationResult = { status: 'approved' | 'cancelled'; queueItemId: QueueItemId; stateVersion: number } | SeatRejected
/** Node name is a configured alias, not a network address. */
export interface SeatNodeStatus { nodeId: SeatNodeId; nodeName: string; engine: 'running' | 'recovering' | 'unavailable'; openEngineWindows: number; limit: number | null; readyAt: SeatTimestamp | null }
/** Reference-price cost includes descendant work and maintenance; missing evidence stays unknown. */
export interface SeatBudgetSnapshot {
  sessionId: SessionId
  seat: SeatName
  currency: 'USD'
  costState: 'known' | 'unknown'
  windowCost: MicroUsd | null
  dailyCost: MicroUsd | null
  limits: SeatBudgetLimits
  dayKey: string
  budgetTimeZone: string
  inFlightUnknown: number
  watermark: number
  budgetRevision: number
}
/** Explicit authorization can change a budget but cannot erase incurred cost. */
export interface ConfigureSeatBudgetRequest {
  sessionId: SessionId
  limits: SeatBudgetLimits
  expectedRevision: number
  authorizationRef: AuthorizationRef
  operationId: SeatOperationId
}
/** Budget changes re-evaluate barriers; they do not restart an uncertain turn. */
export type ConfigureSeatBudgetResult = { status: 'configured'; budget: SeatBudgetSnapshot } | SeatRejected
/** Callback facts have stable identities and monotonic state versions per source and window. */
export interface SeatCallbackBase {
  callbackId: CallbackId
  sourceId: SeatSourceId
  triggerId: TriggerId | null
  stateVersion: number
  seat: SeatName
  title: string | null
  sessionId: SessionId | null
  nodeId: SeatNodeId
  nodeName: string
  budget: SeatBudgetLimits
  taskId?: SeatTaskId
  relatedTaskIds: readonly SeatTaskId[]
}
/** Replacement failure is separate from opening failure and names cleanup state and cause. */
export type SeatCallbackPayload = SeatCallbackBase & (
  | { kind: 'opened'; sessionId: SessionId; title: string }
  | { kind: 'opening-failed'; reason: SeatFailure }
  | { kind: 'window-ended'; reason: WindowEndReason; endedAt: SeatTimestamp; selfReport: CloseSelfReport | null; selfReportStatus: 'submitted' | 'not-submitted' | 'revoked'; reportId?: CloseReportId }
  | { kind: 'budget-stopped'; budgetSnapshot: SeatBudgetSnapshot }
  | { kind: 'rejected'; reason: SeatFailure }
  | { kind: 'replacement-failed'; replacementId: ReplacementId; oldSessionId: SessionId; newSessionId: SessionId | null; reason: ReplacementFailureCode; cause: SeatFailure; cleanup: 'not-created' | 'closed' | 'pending' }
)
/** At-least-once outbox keeps the same payload and callback ID across all retries. */
export interface SeatCallbackDelivery { payload: SeatCallbackPayload; payloadDigest: SeatDigest; attempt: number; phase: 'pending' | 'retry-due' | 'paused' | 'delivered'; nextDue: SeatTimestamp | null; responseClass: 'success' | 'transient' | 'authentication' | 'protocol' | 'unknown' | null }
/** Source registration owns credentials outside the ledger and returns an awaited disposer. */
export interface SeatTriggerSource { sourceId: SeatSourceId; kinds: readonly SeatTrigger['kind'][]; maxRedeliveryMs: number | null; callback: (payload: SeatCallbackPayload) => Promise<void> }
/** Effect cursor is exclusive and filters do not prevent its advancement. */
export interface EngineCursor { nodeId: SeatNodeId; sequence: number; effectIndex: number }
/** Time interval is left-closed and right-open; offline imports are read-only. */
export interface EngineQueryRequest {
  nodeId?: SeatNodeId
  seat?: SeatName
  kinds?: readonly EngineEventKind[]
  from?: SeatTimestamp
  to?: SeatTimestamp
  cursor?: EngineCursor
  limit: number
}
/** Projection pages explicitly expose completeness and a committed watermark. */
export interface EngineQueryResult { effects: readonly EngineEffect[]; complete: boolean; watermark: number; nextCursor?: EngineCursor }
/** Export requires explicit raw-data authorization; redaction is the default. */
export interface EngineExportRequest { query: EngineQueryRequest; format: 'jsonl'; output: string; authorizationRef?: AuthorizationRef }
/** Export records its stable sequence range and content digest. */
export type EngineExportResult = { status: 'exported'; count: number; digest: SeatDigest; watermark: number } | SeatRejected
/** Verification reads an explicit file and never activates imported windows. */
export interface EngineVerifyRequest { input: string }
/** Tail fragments remain preserved; middle corruption prohibits writes. */
export type EngineVerifyResult = { status: 'verified'; decisions: number; watermark: number; tail: 'complete' | 'fragment-preserved' } | SeatRejected

/** Deployment limits must be validated before ingress becomes ready; no private policy defaults. */
export interface SeatEngineConfig {
  nodeName: string
  nodeAliases: Readonly<Record<string, SeatNodeId>>
  dedupWindowMs: number
  maxDecisionBytes: number
  maxSourceBytes: number
  maxBatchSeats: number
  maxCauseDepth: number
  nodeEngineWindowLimit?: number
  budgetTimeZone: string
  callbackTimeoutMs: number
  callbackMaxResponseBytes: number
  callbackRetryInitialMs: number
  callbackRetryMaxMs: number
  ownerObserveIntervalMs: number
  ownerReleaseBudgetMs: number
  queueWakeBudgetMs: number
}
/** Policies share one gate registry while validated tunables remain deployment-owned. */
export interface SeatGateConfig {
  definitions: readonly GateDefinition[]
  pollingThreshold: number
  maxSleepSeconds: number
  checkpointMaxBytes: number
  checkpointRetryLimit: number
  ledgerCheckpointReserveTokens: number
  memoryAuditMaxBytes: number
  memoryAuditMaxFiles: number
}
/** Gate count queries group by ID and revision, preserving expiration facts. */
export interface ListSeatGatesRequest { gateId?: string; hook?: GateHook; cursor?: EngineCursor; limit: number }
/** Counts come from committed facts, never from mutable configuration. */
export interface ListSeatGatesResult { gates: readonly GateSnapshot[]; complete: boolean; watermark: number; nextCursor?: EngineCursor }
/** An engine writer atomically commits a bounded decision, not separate projection files. */
export interface EngineTransactionRequest { expectedSequence: number; decision: EngineDecision }
/** CAS misses expose current sequence; failure never acknowledges durable acceptance. */
export type EngineTransactionResult = { status: 'committed'; decision: EngineDecision } | { status: 'conflict'; actualSequence: number } | SeatRejected
/** Snapshot is current-context evidence, never cumulative accounting tokens. */
export type SeatContextUsage = { status: 'known'; source: 'last-call-usage' | 'compaction-surface'; tokens: number; observedAt: SeatTimestamp; estimated: true; contextEpoch: number } | { status: 'unknown'; observedAt: SeatTimestamp }
/** Registered roots are selected by identity; callers cannot supply arbitrary authorized roots. */
export interface SeatDirectoryRoot { rootId: Branded<'SeatDirectoryRootId'>; path: string; kind: 'startup' | 'additional' | 'memory'; writable: boolean }
/** Directory tools retain the underlying filesystem permission and approval policy. */
export interface SeatDirectoryRequest { sessionId: SessionId; rootId: SeatDirectoryRoot['rootId']; relativePath: string }
/** Reads are bounded by the caller and never treated as write authorization. */
export interface SeatDirectoryReadRequest extends SeatDirectoryRequest { maxBytes: number }
/** Writes require the caller's original operation identity for attribution. */
export interface SeatDirectoryWriteRequest extends SeatDirectoryRequest { content: string; operationId: SeatOperationId }
/** Exact edits preserve the underlying filesystem tool's match requirements. */
export interface SeatDirectoryEditRequest extends SeatDirectoryRequest { oldText: string; newText: string; operationId: SeatOperationId }
/** Read truncation is explicit instead of presenting partial content as complete. */
export type SeatDirectoryReadResult = { status: 'read'; content: string; complete: boolean } | SeatRejected
/** A write result is published only after the provider completes the mutation. */
export type SeatDirectoryWriteResult = { status: 'written'; path: string } | SeatRejected
/** Worktree identity is explicitly registered and verified against git, never inferred by scanning. */
export interface SeatWorktreeRegistration { repositoryId: string; path: string; seat: SeatName; taskId: SeatTaskId; kind: 'light' | 'client'; branch: string; registeredAt: SeatTimestamp }
/** Force requires explicit authorization and a reason, not a model's prose assertion. */
export interface RegisterSeatWorktreeRequest {
  registration: SeatWorktreeRegistration
  operationId: SeatOperationId
  force?: { reason: string; authorizationRef: AuthorizationRef }
}
/** Task settlement only suggests cleanup; it never deletes or commits a dirty tree. */
export interface SeatTaskEndedRequest { taskId: SeatTaskId; kind: 'settle' | 'close' | 'void'; sourceId: SeatSourceId; operationId: SeatOperationId }
/** Worktree policy returns executable alternatives without performing destructive cleanup. */
export type SeatWorktreeResult = { status: 'registered' | 'observed'; trees: readonly SeatWorktreeRegistration[]; alternatives: readonly string[] } | SeatRejected
/** Reference-account diagnostics are evidence for future limits, not an active account limiter. */
export interface SeatAccountUsageRequest { from: SeatTimestamp; to: SeatTimestamp; nodeId?: SeatNodeId }
/** Unknown account identity has its own bucket and is never assigned to a guessed provider. */
export interface SeatAccountUsageBucket {
  accountLabel: string | null
  attempts429: number
  attempts503: number
  uniqueCalls429: number
  uniqueCalls503: number
  concurrencyPeak: number | null
  complete: boolean
}
/** Account totals expose the query that can reproduce them and the accounting watermark. */
export interface SeatAccountUsageResult {
  accounts: readonly SeatAccountUsageBucket[]
  watermark: number
  complete: boolean
  queryCommand: string
}
/** Latest binding query distinguishes missing engine metadata from a free identity. */
export interface SeatBindingRequest { sessionId: SessionId; nodeId?: SeatNodeId }
/** Callback observation never redelivers a payload or creates a new window. */
export interface SeatOperationQuery { operationId: SeatOperationId }
/** Local executor owns Session side effects; the engine owns identities and recovery stages. */
export interface SeatOpenExecutor {
  /** Deliver a durable next-turn warning; operationId deduplicates recovery retries in M5. */
  notifyBudget?(request: { sessionId: SessionId; operationId: SeatOperationId; messageClass: 'handoff'; mode: 'steer'; budget: SeatBudgetSnapshot }): Promise<void>
  /** Inspect persistent identity without creating or resuming model execution. */
  observe(open: import('./events.ts').EngineOpenData): Promise<'absent' | 'matching' | 'conflict' | 'unknown'>
  /** Bind trusted M4 identity and enforce never-mint creation before returning the flushed Session ID. */
  create(open: import('./events.ts').EngineOpenData): Promise<SessionId>
  /** Reconcile one stage using the intent identity; reject conflicting later user changes. */
  configure(open: import('./events.ts').EngineOpenData, stage: OpenConfigurationStage): Promise<void>
  /** Query or send the same durable M5 opening operation; never rerun an uncertain model turn. */
  opening(open: import('./events.ts').EngineOpenData): Promise<{ messageId: Branded<'MessageId'>; state: 'pending' | 'completed' | 'failed' }>
  /** Recheck the original message before waking only its sender with the fixed operation identity. */
  wakeSender(timeout: SeatHandoffTimeout): Promise<'sent' | 'cancelled' | 'unavailable'>
  /** Unknown owners retain resources; death must already have a durable terminal observation. */
  owner(owner: ResourceOwner): Promise<'alive' | 'dead' | 'unknown'>
}
/** Child admission allocates no running slot until the journal commits its ticket. */
export interface AdmitSeatChildRequest {
  ticket: ChildAdmissionTicket
  maxActive: number
}
/** Turn admission leaves queued input untouched when policy defers a new turn. */
export type SeatTurnAdmission = { status: 'allow' } | { status: 'defer'; reason: 'budget-stopped' | 'budget-unverifiable' | 'configuring' | 'owner-unknown' }
/** An uncertain operation remains unknown until recovery establishes a committed fact. */
export type SeatOperationResult = { status: 'missing' } | { status: 'pending'; phase: OpenPhase | ClosePhase | ReplacePhase; stateVersion: number } | { status: 'settled'; result: OpenSeatResult | CloseSeatResult | ReplaceSeatResult | WakeSeatResult | RenewSeatResult | RenameSeatResult }
