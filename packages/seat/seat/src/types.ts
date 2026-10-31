/** Shared seat declarations; durable records belong to the engine, never the Session event union. */
import type { Branded } from '@panedesk/dsh-brand'
import type { SessionId } from '@panedesk/dsh-session/types'
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
/** A bounded checkpoint section or whole file; required content cannot be silently omitted. */
export interface SeatCheckpointFile {
  path: string
  section: string
  /** Omitted selects the unique Markdown section; file includes all source bytes and ignores section. */
  mode?: 'section' | 'file'
  maxBytes: number
  required: boolean
}
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
  /** Explicit remote-opening allowlists; omission denies remote admission. */
  remoteAdmission?: SeatRemoteAdmission
  wakeTemplate?: SeatText
  /** Omitted enables idle cache maintenance; false disables automatic renewal. */
  autoKeepAlive?: boolean
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
export type SeatScheduleSelector = Omit<import('@panedesk/dsh-schedule/client').ScheduleCreateRequest, 'prompt' | 'title'>
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
  | 'open-create-failed' | 'open-configuration-failed' | 'opening-failed' | 'opening-owner-lost'
  | 'session-id-conflict' | 'replacement-open-failed' | 'replacement-first-turn-failed'
  | 'replacement-cleanup-failed' | 'wait-id-conflict' | 'wait-object-not-found'
  | 'wait-object-unauthorized' | 'ticket-not-found' | 'ticket-cancelled'
  | 'report-not-found' | 'report-revoked' | 'causal-depth-exceeded'
  | 'rule-self-loop' | 'query-cursor-invalid' | 'export-event-conflict'
  | 'worktree-client-limit' | 'worktree-unverified'
/** Safe diagnostic without credentials, signatures, network locations or raw source bodies. */
export interface SeatFailure {
  /** Sanitized original refusal; the outer compatibility code remains unchanged. */
  cause?: SeatFailureCause | SeatCancellationCause
  /** Retained prerequisite identity: an absent preset or an unavailable model in an existing Session. */
  details?: { agentPreset: string } | { provider: string; model: string }
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
  /** Manual-only exact registered directory; omission preserves the profile startup directory. */
  startupDirectory?: string
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
  | { status: 'replacement'; result: ReplaceSeatResult }
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
export interface RenewSeatRequest {
  sessionId: SessionId
  operationId: SeatOperationId
  nodeId?: SeatNodeId
  /** Missing means a human-requested renewal; schedulers explicitly select auto. */
  source?: 'manual' | 'auto'
}
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
  | {
    status: 'sent' | 'stored-budget-stopped'
    sessionId: SessionId
    messageId: Branded<'MessageId'>
    operationId: SeatOperationId
    /** Human-readable committed title; never used for addressing or deduplication. */
    title?: string }
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
    /** Verified roster evidence, never inferred from opening text. */
    staffBinding?: SeatVerifiedStaffBinding
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
  /** Frozen provider input retained for FIFO replay; never contains a live Agent or signal. */
  activation?: SeatJson
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
  /** Optional source references come only from registered adapters and are resolved by the host freezer. */
  openingContext?: OpeningContextReference
  relatedTaskIds?: readonly SeatTaskId[]
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
  /** First accepted opening snapshot; coalescing and dispatch retain this revision. */
  frozenOpen?: SeatFrozenOpen
  /** Frozen window title when available; absent means no retained title, not a generated preview. */
  windowName?: string
  /** Authenticated target from a retained opening route; absent when no target identity was frozen. */
  nodeId?: SeatNodeId
  /** Matching frozen rule limits in micro-USD; absent when no budget limits were retained. */
  budget?: SeatBudgetLimits
  queueItemId: QueueItemId
  seat: SeatName
  projectId: SeatProjectId
  triggerKind: SeatTrigger['kind']
  action: 'open' | 'wake-sender' | 'replace'
  /** Present only for an engine-owned replacement queue item. */
  replacementId?: ReplacementId
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
export interface CancelPendingSeatRequest {
  queueItemId: QueueItemId
  expectedStateVersion: number
  operationId: SeatOperationId
  reason?: string
}
/** Authorized cancellation evidence; redacted exports retain only reason presence. */
export interface SeatCancellationRecord {
  authorizationId: AuthorizationRef
  principalId: SeatPrincipalId
  kind: import('./authorization.ts').SeatIssuedAuthorizationKind
  operationId: SeatOperationId
  queueItemId: QueueItemId
  cancelledAt: SeatTimestamp
  stateVersion: number
  reason?: string
  reasonPresent: boolean
}
/** A settled cancellation retains attribution without changing legacy mutation replies. */
export interface SeatCancellationReceipt { status: 'cancelled'; cancellation: SeatCancellationRecord }
/** Lifecycle refinements preserve the existing revision-conflict error category. */
export type SeatCancellationReasonCode = 'queue-item-dispatched' | 'queue-item-opened' | 'queue-item-unknown'
/** Cancellation diagnostics do not widen node-delegation evidence refusals. */
export interface SeatCancellationCause extends Omit<SeatFailureCause, 'reasonCode'> { reasonCode: SeatCancellationReasonCode }
/** Pending mutation is revision-checked and can settle without creating a window. */
export type PendingSeatMutationResult = { status: 'approved' | 'cancelled'; queueItemId: QueueItemId; stateVersion: number } | SeatRejected
/** Node name is a configured alias, not a network address. */
export interface SeatNodeStatus {
  nodeId: SeatNodeId
  nodeName: string
  engine: 'running' | 'recovering' | 'unavailable'
  openEngineWindows: number
  limit: number | null
  readyAt: SeatTimestamp | null
  /** Current runtime failure; absent before failure or after a successful supervised retry. */
  failure?: {
    site: string
    code: string
    since: SeatTimestamp
    retryable: boolean
    attempts: number
    /** Present after the continuous unavailable interval exceeds ten minutes; cleared with the failure. */
    unavailableOverTenMinutes?: true
  }
  /** Authentication refusals parked without effects; leaving the parked state clears the diagnostic, not audit facts. */
  callbackFailures?: readonly {
    callbackId: CallbackId
    seat: SeatName
    code: 'unauthorized' | 'callback-authentication-failed'
  }[]
  /** Latest prerequisite failure per seat; successful opening or model readmission clears the diagnostic, not audit facts. */
  openingFailures?: readonly {
    sessionId: SessionId
    seat: SeatName
    agentPreset: string
    code: SeatFailure['code'] | 'UNKNOWN_MODEL' | 'session/model-unavailable'
    /** Live-turn failures clear after a completed resend or runtime disposal, without altering opening state. */
    stage?: 'turn'
    provider?: string
    model?: string
  }[]
}
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
  | { kind: 'window-ended'; reason: WindowEndReason; detail?: 'approval-pending-cancelled'; endedAt: SeatTimestamp; selfReport: CloseSelfReport | null; selfReportStatus: 'submitted' | 'not-submitted' | 'revoked'; reportId?: CloseReportId }
  | { kind: 'budget-stopped'; budgetSnapshot: SeatBudgetSnapshot }
  | { kind: 'rejected'; reason: SeatFailure }
  | { kind: 'replacement-failed'; replacementId: ReplacementId; oldSessionId: SessionId; newSessionId: SessionId | null; reason: ReplacementFailureCode; cause: SeatFailure; cleanup: 'not-created' | 'closed' | 'pending' }
)
/** At-least-once outbox keeps the same payload and callback ID across all retries. */
export interface SeatCallbackDelivery {
  /** Latest bounded failure observation; absent on old records and after success. */
  lastDiagnostic?: SeatCallbackDiagnostic
  /** Frozen complete remote callback request; replay retains its original digest. */
  nodeWorkChain?: DeliverSourceCallbackRequest
  payload: SeatCallbackPayload
  payloadDigest: SeatDigest
  attempt: number
  phase: 'pending' | 'retry-due' | 'paused' | 'delivered' | 'abandoned'
  nextDue: SeatTimestamp | null
  responseClass: 'success' | 'transient' | 'authentication' | 'protocol' | 'unknown' | null
}
/** Operators resolve an existing parked callback without replacing its identity. */
export interface CallbackResolveRequest {
  callbackId: CallbackId
  action: 'resume' | 'abandon'
  expectedAttempt: number
}
/** Fixed resolution refusals leave the engine journal unchanged. */
export type CallbackResolveResult = { status: 'ok'; callbackId: CallbackId; phase: SeatCallbackDelivery['phase']; attempt: number }
  | { status: 'rejected'; code: 'callback-unknown' | 'callback-not-paused' | 'callback-attempt-conflict' | 'callback-resolution-unauthorized' }
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
  /** Explicit external source events wake remote seats with their frozen context; omission keeps opening ingress. */
  sourceWake?: readonly { sourceId: SeatSourceId; eventTypes: readonly string[] }[]
  /** Append frozen task text to authenticated wake messages, bounded by maxSourceBytes; omission keeps template-only delivery. */
  frozenWakeContext?: boolean
  /** Opt-in failure supervision; omission preserves latched status and existing scheduling. */
  failureRecovery?: {
    /** Positive initial retry delay, at most 300000 ms; exponential retries cap at five minutes. */
    retryInitialMs: number
    /** Positive maximum attempts in an owner-release recovery interval; omission permits three attempts. */
    ownerReleaseMaxAttempts?: number
  }
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
  /** Query the original replacement turn; absent evidence keeps the old window open. */
  replacementFirstTurn?(open: import('./events.ts').EngineOpenData): Promise<import('./events.ts').EngineReplacementData['firstTurn']>
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
/** Archive under the engine barrier; completion does not replace the engine resource commit. */
export interface SeatCloseExecutor {
  /** Read current busy evidence; unknown evidence must not count as idle. */
  evidence(sessionId: SessionId): Promise<{ stateVersion: number; busyReasons: readonly SeatBusyReason[] }>
  /** Called only after the close barrier commits; replay must not reopen the window. */
  archive(request: { sessionId: SessionId; operationId: SeatOperationId }): Promise<void>
}
/** Accepted configuration and title remain fixed while resource admission is queued. */
export interface SeatFrozenOpen {
  /** Required-capability admission retains the full source context and route for rechecks. */
  nodeWorkChain?: NodeWorkChainAcceptedData
  /** A registered execution policy must confirm this item again; absence never grants permission. */
  recheckRequired?: true
  definition: SeatDefinition
  title: string
  openingMode: 'auto' | 'prefill'
  frozenOpening?: NonNullable<import('./events.ts').EngineOpenData['frozenOpening']>
  /** Source references, revisions and scopes freeze with admission snapshots and are not resolved again during recovery. */
  openingContext?: OpeningContextSnapshot
}
/** Trusted provider capabilities are registered privately with the engine, never exposed as external authority. */
export interface SeatEngineLocalAccess {
  /** Whether newly accepted items require the registered execution policy after restart. */
  requiresRecheck?(): boolean
  /** Recheck before dispatch or recovered creation; unknown refusals retain the queue and reservations. */
  recheck?(item: PendingSeatItem): Promise<SeatRejected | null>
  /** Refuse a manual opening before acceptance; omitted preserves admission unchanged. */
  preAdmit?(input: SeatLocalOpenRequest): Promise<SeatRejected | null>
  list(request: ListSeatWindowsRequest): Promise<ListSeatWindowsResult>
  close(request: CloseSeatRequest): Promise<CloseSeatResult>
  freeze(definition: SeatDefinition, trigger: TriggerEnvelope): Promise<SeatFrozenOpen>
  /** The optional context freezer may explicitly reject; without it, events carrying source references are not accepted. */
  freezeContext?(definition: SeatDefinition, trigger: TriggerEnvelope): Promise<SeatFrozenOpen | SeatRejected>
}
/** Frozen manual-open input; the engine allocates Session identity and owns resource admission. */
export interface SeatLocalOpenRequest {
  /** Committed only through the required-capability admission path. */
  nodeWorkChain?: NodeWorkChainAcceptedData
  request: OpenSeatRequest
  authority: SeatCallContext
  definition: SeatDefinition
  opening: NonNullable<import('./events.ts').EngineOpenData['frozenOpening']>
  title: string
  /** Optional trusted source snapshot; existing requests and their digests remain unchanged. */
  openingContext?: OpeningContextSnapshot
}
/** Child admission allocates no running slot until the journal commits its ticket. */
export interface AdmitSeatChildRequest {
  ticket: ChildAdmissionTicket
  maxActive: number
}
/** Turn admission leaves queued input untouched when policy defers a new turn. */
export type SeatTurnAdmission = { status: 'allow' } | { status: 'defer'; reason: 'budget-stopped' | 'budget-unverifiable' | 'configuring' | 'owner-unknown' }
/** Registered opening provider identity is not an authorization capability. */
export type OpeningProviderId = Branded<'OpeningProviderId'>
/** An opaque provider-owned reference resolves to one frozen revision. */
export interface OpeningContextReference { providerId: OpeningProviderId; reference: Branded<'OpeningContextReference'>; revision: string }
/** Repository identity is stable across worktrees and node-local path aliases. */
export type TaskRepositoryId = Branded<'TaskRepositoryId'>
/** Scope evidence uses repository-relative paths; unresolved aliases remain unknown. */
export interface TaskScopeEntry { kind: 'file' | 'directory' | 'pattern'; path: string; access: 'read' | 'write' }
/** Patterns are declarative and never executable; unsupported syntax cannot establish disjointness. */
export type TaskScopeEvidence =
  | { status: 'known'; taskId: SeatTaskId; revision: string; repositoryId: TaskRepositoryId; baseRevision: string; entries: readonly TaskScopeEntry[]; patternSyntax: 'literal' | 'glob-v1'; caseSensitive: boolean }
  | { status: 'unknown'; taskId: SeatTaskId; reason: string; alternative: 'serial' }
/** Frozen task associations retain scope evidence for the complete batch. */
export interface SeatTaskScopeContext { taskId: SeatTaskId; seat: SeatName; nodeId: SeatNodeId; scopeEvidence: TaskScopeEvidence; scopeEvidenceRef: Branded<'TaskScopeEvidenceRef'> }
/** Opening text is frozen once; recovery must not reread a mutable provider reference. */
export interface OpeningContextSnapshot {
  reference: OpeningContextReference
  text: string
  digest: SeatDigest
  revision: string
  taskIds: readonly SeatTaskId[]
  scopeEvidence: readonly TaskScopeEvidence[]
}
/** Only authenticated local services resolve opening references. */
export interface OpeningContextProvider {
  providerId: OpeningProviderId
  /** Receive durable manual-opening callbacks; retries retain the payload and original operation identity.
   * @param payload - Engine-owned callback, never supplied by the opening caller.
   * @param context - Frozen provider reference and original manual operation.
   */
  callback?(payload: SeatCallbackPayload, context: { reference: OpeningContextReference; operationId: SeatOperationId }): Promise<void>
  /** Freeze a revision under the original caller's authority.
   * @param reference - Provider-owned revisioned reference, never executable text.
   * @param authority - Host-resolved identity; the reference does not grant access.
   * @returns Immutable opening input or a refusal before session creation.
   */
  resolve(reference: OpeningContextReference, authority: SeatCallContext): Promise<OpeningContextSnapshot | SeatRejected>
}
/** An opt-in request does not alter the existing OpenSeatRequest or its replay digest. */
export interface OpenSeatWithContextRequest extends OpenSeatRequest {
  openingContext: OpeningContextReference
  relatedTaskIds: readonly SeatTaskId[]
}
/** A trusted wake reference is used only when no existing window can receive the wake. */
export interface WakeSeatWithContextRequest extends WakeSeatRequest {
  openingContext: OpeningContextReference
  relatedTaskIds: readonly SeatTaskId[]
}
/** Whole-batch evidence must be admitted before any individual opening. */
export interface OpenSeatBatchWithScopeRequest extends OpenSeatBatchRequest { tasks: readonly SeatTaskScopeContext[] }
/** Trusted scope owner serializes preflight and acceptance; disposal drains admitted operations. */
export interface OpeningScopeAdmission {
  /** Revalidate frozen permission without entering an admission chain that may await engine dispatch.
   * @param item - Durable queue identity, sources and frozen input.
   * @param nodeId - Actual executing node.
   * @returns Null when confirmed; no-effect refusals require fresh preflight, unknown refusals retain occupancy.
   */
  recheck?(item: PendingSeatItem, nodeId: SeatNodeId): Promise<SeatRejected | null>
  /** Evaluate frozen task evidence against the authoritative source and retained reservations.
   * @param context - Complete local batch.
   * @returns Whole-batch scope decision.
   */
  evaluateTaskScopes(context: import('./gates.ts').TaskScopeBatchGateContext): Promise<import('./gates.ts').TaskScopeGateDecision>
  /** Retain reservations before invoking the existing batch executor.
   * @param request - Frozen task associations.
   * @param authority - Authenticated local caller.
   * @param execute - Existing local batch operation, invoked at most once.
   * @returns Original batch result or a preflight rejection.
   */
  batch(request: OpenSeatBatchWithScopeRequest, authority: SeatCallContext,
    execute: () => Promise<OpenSeatBatchResult>): Promise<OpenSeatBatchResult>
  /** Apply the same reservation policy to individual source-backed openings.
   * @param request - Source reference and task associations.
   * @param authority - Authenticated local caller.
   * @param execute - Existing source-backed opening operation.
   * @returns Original opening result or a scope refusal.
   */
  open(request: OpenSeatWithContextRequest, authority: SeatCallContext, execute: () => Promise<OpenSeatResult>): Promise<OpenSeatResult>
}
/** Sole trusted source owner; all three operations are required when registered. */
export interface SeatSourceOwner {
  /** Prepare and retain source input without waiting for execution.
   * @param request - Exact source, epoch, task and operation identities.
   * @param authority - Authenticated original caller.
   * @returns Frozen input and reservation or refusal.
   */
  prepare(request: PrepareSourceOpeningRequest, authority: SeatCallContext): Promise<PrepareSourceOpeningResult>
  /** Recheck the retained reservation without reading source text again.
   * @param request - Original reservation and actual execution node.
   * @param authority - Authenticated restricted caller.
   * @returns Current permission; unknown retains occupancy.
   */
  checkAdmission(request: CheckSourceAdmissionRequest, authority: SeatCallContext): Promise<CheckSourceAdmissionResult>
  /** Retain the callback before performing source-owned writeback steps.
   * @param request - Original callback, route and frozen runtime evidence.
   * @param authority - Authenticated execution-node identity.
   * @returns Committed only after all original steps finish.
   */
  deliverCallback(request: DeliverSourceCallbackRequest, authority: SeatCallContext): Promise<DeliverSourceCallbackResult>
}
/** Source identity matches exactly; an omitted event type accepts any type from that source only. */
export interface ExternalRuleMatch { sourceId: SeatSourceId; eventType?: string }
/** Verified external evidence supplies both operands without changing legacy trigger records. */
export interface ExternalEventMatch { sourceId: SeatSourceId; eventType: string }
/** Closed attribution classes come from trusted entry points, never request JSON. */
export type SeatAuthorizationKind = 'model-tool-call' | 'human' | 'engine' | 'local-operator' | 'node-delegation'
/** Authorization facts explain past decisions but confer no replay authority. */
export interface SeatAuthorizationFact {
  authorizationId: AuthorizationRef
  kind: SeatAuthorizationKind
  /** Present only on locally issued node-delegation facts, never legacy facts or delegations.
   * The receiving policy captures the transport-authenticated sending node in the entry identity;
   * this value must never come from request JSON.
   */
  sourceNodeId?: SeatNodeId
  principalId: SeatPrincipalId
  origin: SeatCallContext['origin']
  nodeId: SeatNodeId
  sessionId?: SessionId
  seat?: SeatName
  taskIds: readonly SeatTaskId[]
  operationId: SeatOperationId
  callId?: Branded<'ToolCallId'>
  rootCallId?: Branded<'ToolCallId'>
  policyRevision: number
  decision: 'allowed' | 'denied'
  reasonCode: string
  requestDigest: SeatDigest
  delegatedBy?: AuthorizationRef
  checkedAt: SeatTimestamp
}
/** Filtered scans advance exclusive cursors even when no task or seat matches. */
export interface SeatAuthorizationQueryRequest {
  taskId?: SeatTaskId
  seat?: SeatName
  nodeId?: SeatNodeId
  kind?: SeatAuthorizationKind
  from?: SeatTimestamp
  to?: SeatTimestamp
  cursor?: EngineCursor
  limit: number
}
/** Old facts lacking attribution remain legacy-unknown and are never backfilled by inference. */
export interface SeatAuthorizationQueryResult {
  facts: readonly SeatAuthorizationFact[]
  complete: boolean
  watermark: number
  nextCursor?: EngineCursor
  legacyAttribution: 'legacy-unknown' | 'none'
}
/** Task filtering is a separate projection request until providers explicitly support it. */
export interface SeatTaskQueryRequest extends EngineQueryRequest { taskId?: SeatTaskId }
/** Node entry delegation is narrowed again at the receiving node and cannot authorize another hop. */
export interface SeatNodeDelegation {
  authorizationRef: AuthorizationRef
  principalId: SeatPrincipalId
  sourceNodeId: SeatNodeId
  targetNodeId: SeatNodeId
  sessionId?: SessionId
  seat?: SeatName
  taskIds: readonly SeatTaskId[]
  operationId: SeatOperationId
  requestDigest: SeatDigest
  expiresAt: SeatTimestamp
  hop: 1
  kind: 'node-delegation'
}

/** Remote opening permission never grants renewal or implicit wake permission. */
export type SeatRemoteOpeningMethod = 'engine.acceptFrozen' | 'seat.openFrozen' | 'seat.wakeFrozen'
/** Closed method set negotiated separately from the legacy node-link methods. */
export type NodeWorkChainMethod = SeatRemoteOpeningMethod | 'source.prepareOpening' | 'source.checkAdmission' | 'source.deliverCallback' | 'chain.operation' | 'seat.definitionRevision'
/** Exact observation of one target-local definition; identity comes from authenticated transport. */
export interface SeatDefinitionRevisionRequest {
  seat: SeatName
  sourceId: SeatSourceId
  sourceOwnerNodeId: SeatNodeId
  ownerEpoch: OwnerEpoch
  openingMethod: SeatRemoteOpeningMethod
  taskIds: readonly SeatTaskId[]
}
/** Only the owning node's positive safe-integer revision is disclosed. */
export type SeatDefinitionRevisionResult = { status: 'found'; nodeId: SeatNodeId; seat: SeatName; revision: number } | SeatRejected
/** Immediate observations never create business intents or authorize frozen execution. */
export interface SeatDefinitionRevisionProvider {
  /** Await local read and authorization recovery.
   * @returns Readiness of this registration, never a withdrawn predecessor.
   */
  ready(): Promise<void>
  /** Observe current registration ownership synchronously.
   * @returns False before readiness or after withdrawal.
   */
  available(): boolean
  /** Read one local definition under an independently issued exact read grant.
   * @param request - Complete read scope, including the intended frozen opening method.
   * @param authority - Live receiver-issued authority; historical facts grant nothing.
   * @returns Only the exact node, seat and revision, or a sanitized refusal.
   */
  read(request: SeatDefinitionRevisionRequest, authority: SeatCallContext): Promise<SeatDefinitionRevisionResult>
}
/** Nonempty, unique, wildcard-free lists are validated by the admission provider. */
export interface SeatRemoteAdmission {
  allowOpen: true
  sourceNodeIds: readonly SeatNodeId[]
  sourceIds: readonly SeatSourceId[]
  principalIds: readonly SeatPrincipalId[]
  methods: readonly SeatRemoteOpeningMethod[]
  policyRevision: number
}
/** Safe original diagnostics; code is a bounded ASCII identifier, reason is bounded UTF-8. */
export interface SeatFailureCause {
  domain: string
  code: string
  reason: string
  effectState: SeatFailure['effectState']
  retryable: boolean
  operationId: SeatOperationId
  nodeId: SeatNodeId
  reasonCode?: NodeWorkChainReasonCode
}
/** Closed refinements of existing outer refusal categories. */
export type NodeWorkChainReasonCode =
  | 'peer-capability-missing' | 'remote-open-not-allowed' | 'principal-mapping-missing'
  | 'source-mismatch' | 'node-mismatch' | 'principal-mismatch'
  | 'evidence-missing' | 'evidence-revoked' | 'evidence-digest-mismatch'
  | 'frame-too-large' | 'hello-policy-not-ready' | 'method-not-allowed'
  | 'owner-epoch-mismatch' | 'seat-revision-mismatch' | 'scope-reservation-mismatch'
  | 'operation-payload-conflict' | 'protocol-version-mismatch' | 'authentication-unconfirmed'
  | 'tunnel-disconnected' | 'outcome-unknown' | 'deadline-exceeded' | 'invalid-diagnostic'
/** Callback routing is logical, never a URL or executable provider path. */
export type NodeWorkChainCallbackPath =
  | { kind: 'source'; sourceId: SeatSourceId }
  | { kind: 'opening-context'; reference: OpeningContextReference; operationId: SeatOperationId }
/** Source policy is retained and intersected with current target policy at every dispatch. */
export interface NodeWorkChainModeCeiling {
  mode: EngineMode
  policy: { sourceId: SeatSourceId; projectId: SeatProjectId; revision: number; ruleId?: SeatRuleId }
}
/** Immutable admission association retained with the original trigger and authorization. */
export interface NodeWorkChainRoute {
  sourceId: SeatSourceId
  sourceOwnerNodeId: SeatNodeId
  ownerEpoch: OwnerEpoch
  triggerId: TriggerId | null
  originalOperationId: SeatOperationId
  targetNodeId: SeatNodeId
  snapshotDigest: SeatDigest
  callbackPath: NodeWorkChainCallbackPath
  modeCeiling: NodeWorkChainModeCeiling
}
/** Only authenticated roster evidence can supply an employee binding. */
export interface SeatVerifiedStaffBinding {
  staffId: Branded<'SeatStaffId'>
  seat: SeatName
  taskIds: readonly SeatTaskId[]
  evidenceRef: Branded<'SeatStaffEvidenceRef'>
  revision: string
  verifiedAt: SeatTimestamp
}
/** Scope remains owned by the source; unknown outcomes never release this reservation. */
export interface NodeWorkChainScopeReservation {
  reservationId: Branded<'SeatScopeReservationId'>
  sourceId: SeatSourceId
  sourceOwnerNodeId: SeatNodeId
  ownerEpoch: OwnerEpoch
  operationId: SeatOperationId
  taskIds: readonly SeatTaskId[]
  snapshotDigest: SeatDigest
  policyRevision: number
}
/** Target consumes frozen text and binding without resolving the source provider again. */
export interface NodeWorkChainOpeningContext {
  snapshot: OpeningContextSnapshot
  staffBinding?: SeatVerifiedStaffBinding
  scopeReservation: NodeWorkChainScopeReservation
  openingMode: 'auto' | 'prefill'
}
/** Runtime evidence is frozen on first callback construction, including missing evidence. */
export type SeatExecutionModelEvidence =
  | { status: 'present'; provider: string; model: string; kind: 'request/header' | 'model/selection'; sessionId: SessionId; nodeId: SeatNodeId; recordRef: Branded<'SeatModelRecordRef'>; observedAt: SeatTimestamp }
  | { status: 'missing'; sessionId: SessionId | null; nodeId: SeatNodeId; observedAt: SeatTimestamp }

/** Frozen source admission; target configuration is resolved locally at this revision. */
export interface AcceptFrozenTriggerRequest {
  envelope: TriggerEnvelope
  openingContext: NodeWorkChainOpeningContext
  expectedSeatRevision: number
  route: NodeWorkChainRoute
}
/** Source admission retains the existing result variants. */
export type AcceptFrozenTriggerResult = AcceptTriggerResult
/** Manual opening carries the complete frozen input, never a provider lookup instruction. */
export interface OpenFrozenSeatRequest {
  request: OpenSeatRequest
  openingContext: NodeWorkChainOpeningContext
  expectedSeatRevision: number
  route: NodeWorkChainRoute
}
/** Frozen opening preserves legacy open outcomes. */
export type OpenFrozenSeatResult = OpenSeatResult
/** Existing windows use normal wake eligibility; only an absent window consumes the snapshot. */
export interface WakeFrozenSeatRequest {
  request: WakeSeatRequest
  openingContext: NodeWorkChainOpeningContext
  expectedSeatRevision: number
  route: NodeWorkChainRoute
}
/** Frozen wake preserves legacy wake outcomes. */
export type WakeFrozenSeatResult = WakeSeatResult
/** Preparation authorizes and persists a snapshot and reservation at the sole source owner. */
export interface PrepareSourceOpeningRequest {
  sourceId: SeatSourceId
  sourceOwnerNodeId: SeatNodeId
  ownerEpoch: OwnerEpoch
  reference: OpeningContextReference
  seat: SeatName
  taskIds: readonly SeatTaskId[]
  operationId: SeatOperationId
  targetNodeId: SeatNodeId
  expectedSeatRevision: number
  openingMode: 'auto' | 'prefill'
}
/** Prepared input is durable but does not authorize its subsequent execution. */
export type PrepareSourceOpeningResult =
  | { status: 'prepared'; openingContext: NodeWorkChainOpeningContext; route: NodeWorkChainRoute; expectedSeatRevision: number }
  | SeatRejected
/** Exact reservation recheck never rereads opening text or approves a reminder queue. */
export interface CheckSourceAdmissionRequest {
  scopeReservation: NodeWorkChainScopeReservation
  route: NodeWorkChainRoute
  taskIds: readonly SeatTaskId[]
  operationId: SeatOperationId
  executionNodeId: SeatNodeId
}
/** Unknown authority retains reservations and cannot be interpreted as permission. */
export type CheckSourceAdmissionResult =
  | { status: 'allowed'; policyRevision: number }
  | { status: 'denied' | 'unknown'; policyRevision: number | null; error: SeatFailure }
/** Original callback and runtime evidence freeze together before the first delivery attempt. */
export interface DeliverSourceCallbackRequest {
  callback: SeatCallbackPayload
  route: NodeWorkChainRoute
  modelEvidence: SeatExecutionModelEvidence
  payloadDigest: SeatDigest
}
/** Only committed confirms completion of every source-owned callback step. */
export type DeliverSourceCallbackResult =
  | { status: 'pending' | 'committed'; callbackId: CallbackId; payloadDigest: SeatDigest }
  | { status: 'paused'; callbackId: CallbackId; payloadDigest: SeatDigest; error: SeatFailure }
  | SeatRejected
/** Fixed observable callback failure hops; stages never confer execution authority. */
export type SeatCallbackFailureStage =
  | 'retained' | 'issuer' | 'local-query' | 'local-dispatch'
  | 'peer-query' | 'peer-dispatch' | 'owner-inbox' | 'writeback'

/** One safe failure observation, outside the frozen callback payload and digest. */
export interface SeatCallbackDiagnostic {
  stage: SeatCallbackFailureStage
  cause: SeatFailureCause
}

/** Process-local observation wrapper; wire result unions remain unchanged. */
export interface SeatCallbackAttemptResult<R> {
  result: R
  diagnostic?: SeatCallbackDiagnostic
}

/** Optional same-node owner; complete keys are correlation, never authorization.
 * Providers independently recover retained callbacks and validate fresh restricted grants.
 * Publish only after inbox and business recovery; withdrawal stops admission and drains calls.
 */
export interface SeatLocalCallbackOwner {
  /** Await this provider generation's inbox and business recovery. */
  ready(): Promise<void>
  /** Report whether this generation accepts new calls.
   * @returns False before recovery or after withdrawal.
   */
  available(): boolean
  /** Query only source.deliverCallback with a complete callback key.
   * @param request - Retained full business key, including callbackId, and original digest.
   * @returns Exact owner outcome; unready providers must never report missing.
   */
  query(request: NodeWorkChainOperationRequest):
  Promise<SeatCallbackAttemptResult<NodeWorkChainOperationResult>>
  /** Deliver only the original callback after independently verifying its retained identity.
   * @param request - Immutable callback, route, evidence and digest.
   * @param key - Complete source.deliverCallback key with callbackId; grants no authority.
   * @returns Committed only after every original owner step completes.
   */
  deliver(request: DeliverSourceCallbackRequest, key: NodeWorkChainOperationKey):
  Promise<SeatCallbackAttemptResult<DeliverSourceCallbackResult>>
}

/** Full business key is independent of transport request identity and authorization lifetime. */
export interface NodeWorkChainOperationKey {
  sourceNodeId: SeatNodeId
  principalId: SeatPrincipalId
  sourceId: SeatSourceId
  ownerEpoch: OwnerEpoch
  method: NodeWorkChainMethod
  operationId: SeatOperationId
  callbackId?: CallbackId
}
/** An exact lookup neither enumerates operations nor restarts their execution. */
export interface NodeWorkChainOperationRequest {
  key: NodeWorkChainOperationKey
  payloadDigest: SeatDigest
}
/** Settled results remain paired with their original method, excluding recursive queries. */
export type NodeWorkChainSettledResult = {
  [M in Exclude<NodeWorkChainMethod, 'chain.operation' | 'seat.definitionRevision'>]: {
    status: 'settled'
    method: M
    result: NodeWorkChainMethodMap[M]['result']
  }
}[Exclude<NodeWorkChainMethod, 'chain.operation' | 'seat.definitionRevision'>]
/** Missing is reportable only after recovery; pending is not a terminal cached result. */
export type NodeWorkChainOperationResult = { status: 'missing' } | { status: 'pending'; effectState: 'none' | 'unknown' } | NodeWorkChainSettledResult | SeatRejected
/** Provider-owned business methods exclude the query dispatcher itself. */
export type NodeWorkChainBusinessMethod = Exclude<NodeWorkChainMethod, 'chain.operation' | 'seat.definitionRevision'>
/** Durable business owner; registration grants no caller authority. */
export interface NodeWorkChainBusinessProvider {
  /** Nonempty method domain; each method has exactly one provider across the registry. */
  readonly methods: readonly NodeWorkChainBusinessMethod[]
  /** Recover all persisted intents and inbox entries before resolving.
   * @returns Recovery barrier; rejection forbids advertising these receiving capabilities.
   */
  ready(): Promise<void>
  /** Query the full sourceNodeId/principalId/sourceId/ownerEpoch/method/operationId/callbackId key and digest.
   * Before ready resolves, return only pending/unknown, never missing;
   * transport pending and legacy operationId lookup are not business evidence.
   * @param request - Exact original business key and payload digest.
   * @param context - Independently authenticated process-local caller.
   * @returns Durable business outcome; unknown uses pending with effectState unknown.
   */
  query(request: NodeWorkChainOperationRequest, context: SeatCallContext): Promise<NodeWorkChainOperationResult>
  /** Resume only an original intent confirmed missing after recovery, with provider-owned atomic deduplication.
   * @param request - Original complete key and digest; no identity may be replaced or newly allocated.
   * @param context - Restricted outbox identity that the provider must reauthorize before resuming.
   * @returns Original business outcome without blindly repeating an ordinary method call.
   */
  resume?(request: NodeWorkChainOperationRequest, context: SeatCallContext): Promise<NodeWorkChainOperationResult>
}
/** Correlation identity for one work-chain transport attempt, separate from its durable operation. */
export type NodeWorkChainRequestId = Branded<'NodeRequestId'>
/** Shared wire request/result association; no arbitrary namespaces are admitted. */
export interface NodeWorkChainMethodMap {
  'seat.definitionRevision': { request: SeatDefinitionRevisionRequest; result: SeatDefinitionRevisionResult }
  'engine.acceptFrozen': { request: AcceptFrozenTriggerRequest; result: AcceptFrozenTriggerResult }
  'seat.openFrozen': { request: OpenFrozenSeatRequest; result: OpenFrozenSeatResult }
  'seat.wakeFrozen': { request: WakeFrozenSeatRequest; result: WakeFrozenSeatResult }
  'source.prepareOpening': { request: PrepareSourceOpeningRequest; result: PrepareSourceOpeningResult }
  'source.checkAdmission': { request: CheckSourceAdmissionRequest; result: CheckSourceAdmissionResult }
  'source.deliverCallback': { request: DeliverSourceCallbackRequest; result: DeliverSourceCallbackResult }
  'chain.operation': { request: NodeWorkChainOperationRequest; result: NodeWorkChainOperationResult }
}
/** Same-channel lookup checks authenticated peer and explicit evidence access, not delegation recursion. */
export interface NodeDelegationEvidenceRequest {
  authorizationRef: AuthorizationRef
  method: NodeWorkChainMethod
  operationId: SeatOperationId
  payloadDigest: SeatDigest
  sourceNodeId: SeatNodeId
  targetNodeId: SeatNodeId
}
/** A retained original fact is independently fetched, never trusted from the execution request. */
export type NodeDelegationEvidenceResult =
  | { status: 'retained'; request: NodeDelegationEvidenceRequest; fact: import('./authorization.ts').SeatIssuedAuthorizationFact; expiresAt: SeatTimestamp; revoked: false }
  | { status: 'rejected'; cause: SeatFailureCause }
/** Required extension data commits beside the original trigger and issued authorization. */
export interface NodeWorkChainAcceptedData {
  capability: 'node-work-chain/v1'
  route: NodeWorkChainRoute
  openingContext: NodeWorkChainOpeningContext
  expectedSeatRevision: number
  authorizationRef: AuthorizationRef
  payloadDigest: SeatDigest
  operationKey: NodeWorkChainOperationKey
  trigger: TriggerEnvelope | null
}
/** Separate required effect, never an ignorable field in the legacy EngineEffect union. */
export interface NodeWorkChainAcceptedEffect {
  kind: 'node-route/accepted'
  data: NodeWorkChainAcceptedData
}

/** An uncertain operation remains unknown until recovery establishes a committed fact. */
export type SeatOperationResult = { status: 'missing' } | { status: 'pending'; phase: OpenPhase | ClosePhase | ReplacePhase; stateVersion: number } | { status: 'settled'; result: OpenSeatResult | CloseSeatResult | ReplaceSeatResult | WakeSeatResult | RenewSeatResult | RenameSeatResult | SeatCancellationReceipt }
