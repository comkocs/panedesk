/** Append-only ledger facts, query projections, and reference-price vocabulary. */
import type { Branded } from '@panedesk/dsh-brand'
import type { GenerateOptions, ResponseModelReported, TokenUsage } from '@panedesk/dsh-llm'
import type { SessionId } from '@panedesk/dsh-session'

/** Globally unique ledger event identity; duplicate content is idempotent, conflicting content is rejected. */
export type LedgerEventId = Branded<'LedgerEventId'>
/** One observable physical model request, distinct from its retries. */
export type LedgerCallId = Branded<'LedgerCallId'>
/** One session residency or delegated execution lifecycle. */
export type LedgerRunId = Branded<'LedgerRunId'>
/** Links physical attempts of one logical request. */
export type LedgerRequestId = Branded<'LedgerRequestId'>
/** Stable local ledger node identity, unrelated to network addresses. */
export type LedgerNodeId = Branded<'LedgerNodeId'>
/** Durable per-node read position, opaque to consumers. */
export type LedgerWatermark = Branded<'LedgerWatermark'>
/** Runtime-observed terminal classification; upstream detail remains separate. */
export type LedgerEndReason = 'completed' | 'timeout' | 'killed' | 'error' | 'cancelled'
/** Fact categories in the append-only journal. */
export type LedgerEventKind = 'call/start' | 'call/end' | 'run/start' | 'run/end' | 'wait/start' | 'wait/end' | 'cache/break' | 'cache/evidence' | 'retry' | 'compaction' | 'alert' | 'delivery' | 'process/observed' | 'policy/denied'
/** Projection categories; event rows do not count as additional billable calls. */
export type LedgerRowKind = 'call' | 'run' | 'event'
/** Missing evidence is not zero usage. */
export type LedgerUsageState = 'missing' | 'partial' | 'complete'
/** Price coverage for one call; only priced calls carry an amount. */
export type LedgerPricingState = 'priced' | 'missing-price' | 'missing-usage' | 'partial-usage'
/** Auxiliary calls remain billable but can be separated from ordinary traffic. */
export type LedgerPurpose = NonNullable<GenerateOptions['purpose']> | 'conversation'

/** Trusted wait classifications; unregistered tools remain unclassified. */
export type LedgerWaitCategory = 'sleep' | 'external-marker' | 'subagent'
/** Runtime provider configuration; model-authored text never supplies classifications. */
export interface LedgerOptions {
  /** Explicit Harness home; otherwise the shared home-paths resolution applies. */
  dshHome?: string
  /** Maximum native-lock contention wait in milliseconds. */
  lockTimeoutMs?: number
  /** Delay between nonblocking native-lock attempts in milliseconds. */
  lockRetryMs?: number
  /** Maximum encoded journal record or sidecar fragment size in bytes. */
  maxRecordBytes?: number
  /** Maximum age of verified local process observations counted as live. */
  observationMaxAgeMs?: number
  /** Exact registered tool names mapped to trusted categories; no name-based inference. */
  waitTools?: Readonly<Record<string, LedgerWaitCategory>>
}

/** Restricted sidecar streams owned by a physical call. */
export type LedgerArtifactKind = 'partial-response' | 'keepalive-request'
/** Stable sidecar fragment identity; sequence numbers are zero-based contiguous safe integers. */
export interface LedgerArtifactKey {
  callId: LedgerCallId
  kind: LedgerArtifactKind
  seq: number
}
/** Append one lossless JSON value encoded as UTF-8; equality compares these exact bytes. */
export interface LedgerArtifactAppend extends LedgerArtifactKey {
  /** Serialized JSON, without credentials; raw partial output stays in the restricted sidecar only. */
  content: string
}
/** Durable ledger-owned reference; callers never choose a filesystem destination. */
export interface LedgerArtifactReference extends LedgerArtifactKey {
  /** Ledger-relative restricted path, not model-visible content. */
  path: string
  /** SHA-256 of the exact UTF-8 content bytes for this sequence. */
  digest: string
}
/** Equal replays acknowledge durable bytes; conflicts never overwrite or append incoming bytes. */
export type LedgerArtifactAppendResult =
  | { kind: 'appended' | 'existing'; reference: LedgerArtifactReference }
  | { kind: 'conflict'; key: LedgerArtifactKey; existingDigest: string; incomingDigest: string }
/** Durable closure acknowledgement; no further sequence may be appended after closure. */
export interface LedgerArtifactFinishResult {
  kind: 'finished' | 'existing'
  /** Last fragment, verified against the durable stream before closing it. */
  reference: LedgerArtifactReference
}

/** Non-sensitive dispatch identity; absent seat/window resolve explicitly to free. */
export interface LedgerIdentity {
  seat: string
  window: string
  taskId?: string
  nodeId: LedgerNodeId
  /** Startup parameters override environment, then settings; inherited values retain their origin. */
  identitySource: 'startup' | 'environment' | 'settings' | 'inherited' | 'free'
}
/** PID identity must match its creation marker before liveness or signalling is trusted. */
export interface LedgerProcessIdentity {
  nodeId: LedgerNodeId
  pid: number
  processGroupId?: number
  startIdentity?: string | undefined
  bootIdentity?: string
  registeredAt: number
  verification: 'verified' | 'unverified'
}
/** Provider tier names accompany disjoint short/long counts; untiered writes keep only the total. */
export type LedgerCacheWriteTiering =
  | { kind: 'tiered'; short: string; long: string }
  | { kind: 'untiered' }
  | { kind: 'unknown' }
/** Structural cache evidence is distinct from an observed wire prefix. */
export interface LedgerCacheEvidence {
  prefixFingerprint?: string
  fingerprintVersion?: number
  cacheEpoch?: string
  wirePrefixDigest?: string
  breakReasons: readonly string[]
  lastCacheEvidenceAt?: number
  ttlSeconds?: number
  cacheMode: 'disabled' | 'explicit' | 'automatic' | 'unknown'
  retention?: GenerateOptions['cache']
  /** Required evidence when the effective tier is lower than the requested/default tier. */
  downgradeReason?: string
  /** Explicit session override, restored independently of historical request headers. */
  sessionPolicy?: { retention: NonNullable<GenerateOptions['cache']>['retention']; stableKey?: string }
  /** Opt-in maintenance settings; no implicit enablement on recovery. */
  keepalivePolicy?: { enabled: boolean; leadSeconds: number; minimumIntervalSeconds: number; maxOutputTokens: number }
  /** Maintenance failures survive residency changes until an ordinary request or explicit update. */
  keepaliveFailures?: number
  /** Last maintenance attempt prevents restart-driven rapid retries. */
  lastKeepaliveAttemptAt?: number
}
/** Monotonic durations are measured within one process; wall timestamps only correlate observations. */
export interface LedgerInterval {
  kind: 'model-in-flight' | 'queue' | 'backoff' | 'sleep' | 'external-marker' | 'subagent' | 'unclassified'
  startedAt: number
  endedAt?: number
  durationMs?: number
  toolCallId?: Branded<'ToolCallId'>
}
/** Sanitized runtime alert; raw credentials and model-authored claims never enter the journal. */
export interface LedgerAlert {
  code: string
  message: string
  artifact?: string
  redacted: boolean
}
/** Session linkage shared by calls, lifecycle facts, and auxiliary observations. */
export interface LedgerContext extends LedgerIdentity {
  sessionId: SessionId
  parentSessionId?: SessionId
  rootSessionId: SessionId
  subagentRunId?: Branded<'SubagentRunId'>
  remoteSessionId?: SessionId
  /** Credential profile or route label only; unknown when unavailable, never a secret or endpoint. */
  accountLabel: string
}
/** Trusted process-local attribution bound before Session publication; never part of its durable header. */
export interface LedgerSessionContext extends LedgerContext {
  runId: LedgerRunId
  parentRunId?: LedgerRunId
}
/** Journal envelope; schema version is independent of the Session format version. */
export interface LedgerEnvelope {
  schemaVersion: 1
  eventId: LedgerEventId
  nodeId: LedgerNodeId
  observedAt: number
  runId: LedgerRunId
  sessionId: SessionId
  callId?: LedgerCallId
}
/** Request facts frozen before network dispatch; the start append must be durable before release. */
export interface LedgerCallStart extends LedgerContext {
  callId: LedgerCallId
  runId: LedgerRunId
  logicalRequestId: LedgerRequestId
  attemptIndex: number
  attemptVisibility: 'physical' | 'adapter'
  provider: string
  modelFamily: string
  requestedModel: string
  purpose: LedgerPurpose
  startedAt: number
  cache: LedgerCacheEvidence
  cacheWriteTiering: LedgerCacheWriteTiering
  priceVersion: string
  priceKey: string
  referencePrice: true
  /** Restricted request snapshot for auxiliary calls; absent when the Session log owns reconstruction. */
  requestArtifact?: string
}
/** Terminal observation; absent usage, money, or transport facts remain unknown, never zero-filled. */
export interface LedgerCallFinish {
  callId: LedgerCallId
  endedAt: number
  observedAt: number
  responseModel?: string
  responseModelReported: ResponseModelReported | 'not-reported'
  effectiveModel: string
  httpStatus?: number
  usage?: TokenUsage
  /** Numeric wire counters retained independently of Session usage for reproducible accounting. */
  reportedUsage?: Readonly<Record<string, number>>
  usageState: LedgerUsageState
  costUsd?: string
  pricingState: LedgerPricingState
  /** Frozen table version and exact selected key; no fuzzy model alias matching. */
  priceVersion?: string
  priceKey?: string
  priceKeySource?: 'response-model' | 'request-model' | 'unknown'
  wallMs: number
  modelInFlightMs: number
  queueMs: number
  backoffMs: number
  waits: readonly LedgerInterval[]
  peakContextTokens?: number
  peakContextSource?: 'usage' | 'estimate'
  compactionCount: number
  compactionTimes: readonly number[]
  endReason: LedgerEndReason
  upstreamStopReason?: string
  exitCode?: number
  signal?: string
  timeoutSource?: string
  recovered: boolean
  errorArtifact?: string
  /** Durable sidecar references returned by appendArtifact; closure is acknowledged by finishArtifact. */
  artifacts?: readonly LedgerArtifactReference[]
  /** Actual adapter-observed account label; absent when no authoritative label was returned. */
  accountLabel?: string
  /** Actual adapter-observed write tiers; absent when unobservable. */
  cacheWriteTiering?: LedgerCacheWriteTiering
  /** Final cache observation, including actual retention and any downgrade. */
  cache?: LedgerCacheEvidence
  /** Observed failures for this physical call only, not cumulative retry totals. */
  http429Count?: number
  /** Observed failures for this physical call only, not cumulative retry totals. */
  http503Count?: number
}
/** One projected call, joining its start with at most one committed terminal fact. */
export interface LedgerCall {
  kind: 'call'
  start: LedgerCallStart
  finish?: LedgerCallFinish
}
/** Launch intent is not confirmed live execution until a verified process observation arrives. */
export interface LedgerRunStart extends LedgerContext {
  runId: LedgerRunId
  /** Supervising run; distinct from the child residency's own lifecycle. */
  parentRunId?: LedgerRunId
  startedAt: number
  definition?: string
  /** Original enforced policy, retained outside the Session log for cold restoration. */
  executionPolicy?: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort: string
    readonly allowedTools: readonly string[]
    readonly rulesId: string
    readonly version: string
    readonly digest: string
  }
  /** Canonical executionPolicy JSON SHA-256; required evidence for controlled restoration. */
  executionPolicyDigest?: string
  effectiveModel?: string
  processIdentity?: LedgerProcessIdentity
  launchState: 'pending' | 'started'
  deliveryPaths: readonly string[]
}
/** Terminal lifecycle facts; first committed end wins and late observations remain separate events. */
export interface LedgerRunFinish {
  /** External backend totals are aggregate observations, never duplicate physical calls. */
  externalBackend?: {
    definitionEnforcement: 'not-applicable'
    usage?: TokenUsage
    /** Original numeric counters where disjoint cache semantics are not specified by the backend. */
    reportedUsage?: Readonly<Record<string, number>>
    usageState: LedgerUsageState
    processIdentityState: 'reported' | 'not-reported'
  }
  runId: LedgerRunId
  endedAt?: number
  observedAt: number
  endReason: LedgerEndReason
  upstreamStopReason?: string
  exitCode?: number
  signal?: string
  timeoutSource?: string
  recovered: boolean
  deliveryState: 'not-requested' | 'present' | 'missing' | 'uncheckable'
  errorArtifact?: string
}
/** A session residency lifecycle, not an additional model call. */
export interface LedgerLifecycle {
  kind: 'run'
  start: LedgerRunStart
  finish?: LedgerRunFinish
  liveness: 'confirmed' | 'unknown' | 'dead'
}
/** Auxiliary observations retain explicit categories without becoming billable call rows. */
export type LedgerAuxiliaryFact =
  | { kind: 'wait/start' | 'wait/end'; interval: LedgerInterval }
  | { kind: 'cache/break' | 'cache/evidence'; evidence: LedgerCacheEvidence }
  | { kind: 'retry'; phase: 'scheduled' | 'started' | 'exhausted'; logicalRequestId: LedgerRequestId; attemptIndex: number; httpStatus?: number }
  | { kind: 'compaction'; committedSeq: number; committedAt: number; peakContextUsageTokens?: number; peakContextEstimatedTokens?: number }
  | { kind: 'alert'; alert: LedgerAlert }
  | { kind: 'delivery'; paths: readonly string[]; state: LedgerRunFinish['deliveryState']; errorArtifact?: string }
  | { kind: 'process/observed'; identity: LedgerProcessIdentity; liveness: 'confirmed' | 'unknown' | 'dead'; exitCode?: number; signal?: string }
  | { kind: 'policy/denied'; operation: 'model' | 'effort' | 'tool'; requested: string; definition: string; reason: string }
/** Journal facts; start and end are paired by identities rather than counted as separate consumption. */
export type LedgerEvent = LedgerEnvelope & (
  | { kind: 'call/start'; data: LedgerCallStart }
  | { kind: 'call/end'; data: LedgerCallFinish }
  | { kind: 'run/start'; data: LedgerRunStart }
  | { kind: 'run/end'; data: LedgerRunFinish }
  | LedgerAuxiliaryFact
)
/** User-facing projected row vocabulary. */
export type LedgerRow = LedgerCall | LedgerLifecycle | { kind: 'event'; event: LedgerEvent }
/** Half-open business-time filter; calls belong to their start time even across midnight. */
export interface LedgerQuery {
  from?: number
  to?: number
  seat?: string
  window?: string
  taskId?: string
  sessionId?: SessionId
  nodeId?: LedgerNodeId
  model?: string
  modelFamily?: string
  accountLabel?: string
  purpose?: LedgerPurpose
  includeChildren?: boolean
}
/** Consistent query view; incomplete scans must expose that fact. */
export interface LedgerSnapshot {
  asOf: number
  watermarks: Readonly<Record<string, LedgerWatermark>>
  complete: boolean
  rows: readonly LedgerRow[]
}
/** Append outcome preserves idempotence and exposes conflicts without overwriting either payload. */
export type LedgerAppendResult =
  | { kind: 'appended' | 'existing'; event: LedgerEvent; watermark: LedgerWatermark }
  | { kind: 'conflict'; eventId: LedgerEventId; existingDigest: string; incomingDigest: string }
/** Five export columns; untiered writes stay separately labelled rather than masquerading as short writes. */
export interface LedgerTokenColumns {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteShortTokens?: number
  cacheWriteLongTokens?: number
  outputTokens?: number
  cacheWriteTokens?: number
  cacheWriteTiering: LedgerCacheWriteTiering
}
/** Decimal-string USD prices per million tokens; storage price uses the documented token-hour unit. */
export interface LedgerUnitPrices {
  input: string
  output: string
  cacheRead: string
  cacheWrite: Readonly<Record<string, string>>
  cacheStoragePerMillionTokenHour?: string
}
/** Entire-call replacement prices above the threshold, counting uncached input plus cache reads and writes. */
export interface LedgerContextPriceRule {
  thresholdTokens: number
  counting: 'all-input-including-cache-read-write'
  prices: LedgerUnitPrices
}
/** UTC weekday and half-open hour window; crossing midnight requires two explicit rules. */
export interface LedgerTimePriceRule {
  weekdays: readonly (0 | 1 | 2 | 3 | 4 | 5 | 6)[]
  fromHour: number
  toHour: number
  prices: LedgerUnitPrices
}
/** Traceable reference-price metadata, not a statement of a subscriber's actual charges. */
export interface LedgerPriceMetadata {
  version: string
  sourceUrls: readonly string[]
  retrievedOn: string
  reference: true
}
/** One canonical model price; fixtures must identify themselves rather than impersonate official prices. */
export interface LedgerPriceEntry extends LedgerPriceMetadata {
  modelFamily: string
  modelKey: string
  currency: 'USD'
  prices: LedgerUnitPrices
  contextRule?: LedgerContextPriceRule
  timeRules?: readonly LedgerTimePriceRule[]
  holidaysUnmodeled: boolean
}
/** Versioned reference table frozen at call start; repricing is a separate explicit query. */
export interface LedgerPriceTable extends LedgerPriceMetadata {
  entries: readonly LedgerPriceEntry[]
}
/** Inputs for decimal fixed-point pricing; missing evidence produces an unknown amount. */
export interface LedgerPriceUsageRequest {
  usage?: TokenUsage | undefined
  usageState: LedgerUsageState
  tiering: LedgerCacheWriteTiering
  startedAt: number
  entry?: LedgerPriceEntry | undefined
  cacheStorageTokenHours?: string
}
/** Pricing never double counts total cache writes together with their tier breakdown. */
export interface LedgerPriceUsageResult {
  state: LedgerPricingState
  costUsd?: string
  priceVersion?: string
  reference: true
}
/** Decimal fixed-point pricing signature; implementations preserve at least six USD decimal places.
 * @param request - authoritative usage, tier names, time, and frozen price entry.
 * @returns amount and coverage, with no fabricated amount when evidence is absent.
 */
export type PriceUsage = (request: LedgerPriceUsageRequest) => LedgerPriceUsageResult
