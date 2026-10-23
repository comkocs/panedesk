/** Seat Service Definitions; implementations and consumer registrations live in separate packages. */
import { Context, Service } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from './types.ts'
import type { EngineDecision } from './events.ts'
import type { GateContext, GateCriterion, GateResult } from './gates.ts'

export type * from './types.ts'
export * from './events.ts'
export * from './gates.ts'

/** Exhaustive machine-code table shared by parser, SDK and CLI adapters. */
export const SEAT_ERROR_CODES = {
  'seat-not-found': true, 'seat-already-open': true, 'seat-choice-required': true,
  'cross-node-unsupported': true, 'import-preview-stale': true, 'import-conflict': true,
  'import-source-authoritative': true, 'seat-store-authoritative': true,
  'invalid-definition': true, 'invalid-request': true, 'unsupported-schema-version': true,
  'revision-conflict': true, 'operation-id-conflict': true, 'event-id-conflict': true,
  'unauthorized': true, 'unavailable': true, 'disabled': true, 'engine-store-corrupt': true,
  'session-not-found': true, 'session-busy': true, 'state-conflict': true, 'owner-unknown': true,
  'memory-seat-mismatch': true, 'wake-template-missing': true, 'batch-explicit-seats-required': true,
  'batch-limit-exceeded': true, 'cache-evidence-unavailable': true, 'cache-expired': true,
  'cache-prefix-changed': true, 'maintenance-busy': true, 'renewal-uncertain': true,
  'subagent-renewal-expired': true, 'subagent-context-limit': true, 'evidence-unavailable': true,
  'polling': true, 'sleep-limit-exceeded': true, 'gate-denied': true, 'audit-unavailable': true,
  'checkpoint-unavailable': true, 'checkpoint-changed': true, 'checkpoint-budget-exceeded': true,
  'budget-unverifiable': true, 'budget-full': true, 'budget-stopped': true,
  'source-not-found': true, 'source-authentication-failed': true, 'source-payload-too-large': true,
  'source-timestamp-invalid': true, 'callback-authentication-failed': true, 'callback-protocol-error': true,
  'open-create-failed': true, 'open-configuration-failed': true, 'opening-failed': true,
  'session-id-conflict': true, 'replacement-open-failed': true, 'replacement-first-turn-failed': true,
  'replacement-cleanup-failed': true, 'wait-id-conflict': true, 'wait-object-not-found': true,
  'wait-object-unauthorized': true, 'ticket-not-found': true, 'ticket-cancelled': true,
  'report-not-found': true, 'report-revoked': true, 'causal-depth-exceeded': true,
  'rule-self-loop': true, 'query-cursor-invalid': true, 'export-event-conflict': true,
  'worktree-client-limit': true, 'worktree-unverified': true,
} as const satisfies Record<T.SeatErrorCode, true>

declare module '@panedesk/cordis' {
  interface Context {
    seats: SeatService
    seatEngine: SeatEngineService
    seatGates: SeatGateService
    seatDirectories: SeatDirectoryService
  }
}

/** Unified node-local operations; provider derives authority from authenticated context, never wire tags. */
export abstract class SeatService extends Service {
  constructor(ctx: Context) { super(ctx, 'seats') }

  /** Derive an operation-local facade from verified server-side authority, never raw request fields.
   * @param authority - principal, node and origin already authenticated by the trusted adapter.
   * @returns a scoped facade with no process-global current identity.
   */
  abstract withAuthority(authority: T.SeatCallContext): SeatService

  /** List authorized definitions without activating Sessions.
   * @param request - local catalog filters and pagination.
   * @returns revisioned catalog page.
   */
  abstract definitions(request: T.ListSeatDefinitionsRequest): Promise<T.ListSeatDefinitionsResult>
  /** Resolve and freeze all defaults before an operation can produce side effects.
   * @param seat - exact local definition key.
   * @returns validated definition or an actionable rejection.
   */
  abstract resolve(seat: T.SeatName): Promise<T.SeatDefinition | T.SeatRejected>
  /** Edit only when the catalog is authoritative.
   * @param request - replacement definition and expected revision.
   * @returns committed revision or a conflict.
   */
  abstract save(request: T.SaveSeatDefinitionRequest): Promise<T.SeatCatalogMutationResult>
  /** Compare source, baseline and local fields without mutating the catalog.
   * @param request - selected source table, mapping and explicit defaults.
   * @returns per-row preview or a source failure.
   */
  abstract previewImport(request: T.PreviewSeatImportRequest): Promise<T.SeatImportPlan | T.SeatRejected>
  /** Recheck source bytes and revision before applying selected rows.
   * @param request - original preview identity and explicit row selection.
   * @returns committed rows and retained conflicts.
   */
  abstract commitImport(request: T.CommitSeatImportRequest): Promise<T.CommitSeatImportResult>
  /** Change the sole editing authority only with external authorization.
   * @param request - authorized compare-and-swap request.
   * @returns committed catalog revision.
   */
  abstract setAuthority(request: T.SetSeatAuthorityRequest): Promise<T.SeatCatalogMutationResult>
  /** List runtime-derived states, including unavailable evidence.
   * @param request - authorized local filters and cursor.
   * @returns windows and unopened definitions with completeness.
   */
  abstract list(request: T.ListSeatWindowsRequest): Promise<T.ListSeatWindowsResult>
  /** Create through one durable intent; bind ledger identity before the first run starts.
   * @param request - caller-stable identity and exact definition.
   * @returns created, prefilled, pending, choice or rejected outcome.
   */
  abstract open(request: T.OpenSeatRequest): Promise<T.OpenSeatResult>
  /** Validate the entire explicit name list before opening any window.
   * @param request - bounded names without wildcard expansion.
   * @returns independent per-seat outcomes.
   */
  abstract openBatch(request: T.OpenSeatBatchRequest): Promise<T.OpenSeatBatchResult>
  /** Perform one cache maintenance request without adding conversation text.
   * @param request - retained operation identity and local Session.
   * @returns renewed, rejected or uncertain with cache evidence.
   */
  abstract renew(request: T.RenewSeatRequest): Promise<T.RenewSeatResult>
  /** Close only after an admission barrier and a second complete idle check.
   * @param request - observed state version and operation identity.
   * @returns closed, busy or conflicting state without force-stopping work.
   */
  abstract close(request: T.CloseSeatRequest): Promise<T.CloseSeatResult>
  /** Open new before closing old; queue until both windows fit all capacity limits.
   * @param request - old Session and replacement operation identity.
   * @returns durable replacement phase, including failed-new cleanup.
   */
  abstract replace(request: T.ReplaceSeatRequest): Promise<T.ReplaceSeatResult>
  /** Preserve upstream user-title pinning.
   * @param request - title and retained operation identity.
   * @returns the committed upstream title snapshot.
   */
  abstract rename(request: T.RenameSeatRequest): Promise<T.RenameSeatResult>
  /** Send the definition's wake text or delegate an unopened seat to open.
   * @param request - explicit target when multiple windows exist.
   * @returns mail acknowledgement, open result or candidate choices.
   */
  abstract wake(request: T.WakeSeatRequest): Promise<T.WakeSeatResult>
  /** Inspect metadata held outside the Session log.
   * @param request - local Session identity.
   * @returns binding, null for absent metadata, or a node refusal.
   */
  abstract binding(request: T.SeatBindingRequest): Promise<T.SeatBinding | null | T.SeatRejected>
  /** Resolve traditional creation before any Session or directory side effect.
   * @param request - canonical path and optional single-use confirmation.
   * @returns free admission, seat admission or candidate choices.
   */
  abstract resolveDirectoryChoice(request: T.ResolveDirectoryChoiceRequest): Promise<T.DirectoryChoiceResult>
  /** Record three report fields without treating model claims as runtime state.
   * @param request - bounded report and optional trusted tool attribution.
   * @returns committed report revision.
   */
  abstract submitReport(request: T.SubmitCloseReportRequest): Promise<T.CloseReportResult>
  /** Invalidate an older automatic-close candidate atomically.
   * @param request - report identity and expected state version.
   * @returns committed revocation or conflict.
   */
  abstract revokeReport(request: T.RevokeCloseReportRequest): Promise<T.CloseReportResult>
  /** Register observations without awaiting task completion; tools then conclude the turn.
   * @param request - authorized objects, stable wait and operation identities.
   * @returns durable registration, including already-visible terminal observations.
   */
  abstract registerWait(request: T.RegisterSeatWaitRequest): Promise<T.RegisterSeatWaitResult>
  /** Cancel only observation, never the underlying tasks.
   * @param request - expected wait state and operation identity.
   * @returns cancelled or already settled wait.
   */
  abstract cancelWait(request: T.CancelSeatWaitRequest): Promise<T.CancelSeatWaitResult>
  /** Observe a wait without causing a second wake.
   * @param waitId - retained registration identity.
   * @returns committed state or null if absent.
   */
  abstract wait(waitId: T.WaitId): Promise<T.SeatWait | null>
  /** Observe replacement or opening recovery without resubmitting side effects.
   * @param request - caller-retained operation identity.
   * @returns missing, pending or settled state.
   */
  abstract operation(request: T.SeatOperationQuery): Promise<T.SeatOperationResult>
  /** Read current-context estimates rather than accumulated ledger tokens.
   * @param sessionId - authorized local Session.
   * @returns dated evidence or explicit unknown state.
   */
  abstract contextUsage(sessionId: SessionId): Promise<T.SeatContextUsage>
}

/** Engine owns the journal, queues, resources and outbox; local providers depend only on this definition. */
export abstract class SeatEngineService extends Service {
  constructor(ctx: Context) { super(ctx, 'seatEngine') }
  /** Commit ingress before acknowledging acceptance.
   * @param envelope - authenticated bounded source event.
   * @returns stable accepted, duplicate, coalesced or rejected identity.
   */
  abstract accept(envelope: T.TriggerEnvelope): Promise<T.AcceptTriggerResult>
  /** Register a trusted source without persisting callback code or credentials.
   * @param source - installed source adapter and redelivery horizon.
   * @returns asynchronous disposer that stops ingress and drains accepted calls.
   */
  abstract registerSource(source: T.SeatTriggerSource): () => Promise<void>
  /** Write one complete decision under journal ownership and sequence CAS.
   * @param request - bounded frame and expected committed sequence.
   * @returns durable frame or a sequence conflict.
   */
  abstract transact(request: T.EngineTransactionRequest): Promise<T.EngineTransactionResult>
  /** Frame and commit effects under engine-owned canonical encoding and sequence CAS.
   * @param request - stable decision identity, observed facts and expected committed watermark.
   * @returns committed frame, current watermark conflict or explicit refusal.
   */
  abstract appendEffects(request: { decisionId: import('./events.ts').EngineDecisionId; expectedSequence: number; observedAt: T.SeatTimestamp; policyRevision: number; effects: readonly import('./events.ts').EngineEffect[] }): Promise<T.EngineTransactionResult>
  /** Reconcile original identities without replaying uncertain model side effects.
   * @returns only after recovery barriers and projections are ready.
   */
  abstract ready(): Promise<void>
  /** Stop ingress and drain owned work without deleting persistent queues.
   * @returns only after journal flush and owner-lock release.
   */
  abstract shutdown(): Promise<void>
  /** Report local capacity and recovery state.
   * @returns node alias, window count and explicit unlimited capacity.
   */
  abstract nodeStatus(): Promise<T.SeatNodeStatus>
  /** Select the project mode explicitly, retaining paused work on tightening.
   * @param request - policy revision and new mode.
   * @returns committed modeChosen policy.
   */
  abstract setProjectMode(request: T.SetProjectModeRequest): Promise<T.SetProjectModeResult>
  /** Query project mode without changing the first-choice flag.
   * @param projectId - exact policy owner.
   * @returns resolved policy, defaulting to remind and modeChosen false.
   */
  abstract projectPolicy(projectId: T.SeatProjectId): Promise<T.SeatProjectPolicy>
  /** Read durable pending work without exposing source credentials.
   * @param request - bounded filters and cursor.
   * @returns page, watermark and completeness.
   */
  abstract pending(request: T.ListPendingSeatsRequest): Promise<T.ListPendingSeatsResult>
  /** Approve only reminder confirmation; all other admission rules still apply.
   * @param request - pending identity and expected version.
   * @returns committed approval or conflict.
   */
  abstract approve(request: T.ApprovePendingSeatRequest): Promise<T.PendingSeatMutationResult>
  /** Cancel unopened work without closing an existing window.
   * @param request - pending identity and expected version.
   * @returns committed cancellation or conflict.
   */
  abstract cancel(request: T.CancelPendingSeatRequest): Promise<T.PendingSeatMutationResult>
  /** Reconfigure authorized budget limits without erasing cost evidence.
   * @param request - expected budget revision and authorization reference.
   * @returns reevaluated committed budget.
   */
  abstract configureBudget(request: T.ConfigureSeatBudgetRequest): Promise<T.ConfigureSeatBudgetResult>
  /** Read reference-price cost, including descendants and maintenance.
   * @param sessionId - local window identity.
   * @returns known or unknown cost with the committed watermark.
   */
  abstract budget(sessionId: SessionId): Promise<T.SeatBudgetSnapshot>
  /** Aggregate accounting evidence without imposing an account concurrency default.
   * @param request - half-open interval and optional local-node filter.
   * @returns rate-limit counts, unique calls, peak concurrency and unknown-account bucket.
   */
  abstract accountUsage(request: T.SeatAccountUsageRequest): Promise<T.SeatAccountUsageResult>
  /** Read committed engine effects with exclusive cursor advancement.
   * @param request - bounded filters and half-open time range.
   * @returns effects, watermark and explicit completeness.
   */
  abstract query(request: T.EngineQueryRequest): Promise<T.EngineQueryResult>
  /** Export stable ordered JSONL; raw authorized data is explicit opt-in.
   * @param request - target file and redaction authorization.
   * @returns exported count and digest or an actionable failure.
   */
  abstract export(request: T.EngineExportRequest): Promise<T.EngineExportResult>
  /** Verify an offline file without executing its imported operations.
   * @param request - explicit input file.
   * @returns framing integrity, preserved-tail status and watermark.
   */
  abstract verify(request: T.EngineVerifyRequest): Promise<T.EngineVerifyResult>
  /** Observe admission without blocking the parent tool on capacity.
   * @param ticketId - retained admission identity.
   * @returns committed ticket or null when absent.
   */
  abstract ticket(ticketId: T.ChildTicketId): Promise<T.ChildAdmissionTicket | null>
  /** Cancel an unstarted child request without terminating running work.
   * @param request - parent authorization and expected version.
   * @returns cancelled or already-admitted state.
   */
  abstract cancelTicket(request: T.CancelChildTicketRequest): Promise<T.CancelChildTicketResult>
  /** Replay committed decisions then observe new ones; return releases the subscription.
   * @param cursor - exclusive durable resume point, absent starts at retained history.
   * @returns ordered durable frames; storage errors reject iteration.
   */
  abstract subscribe(cursor?: T.EngineCursor): AsyncIterable<EngineDecision>
}

/** Registry provider owns deterministic evaluation, durable hit counts and expiration. */
export abstract class SeatGateService extends Service {
  constructor(ctx: Context) { super(ctx, 'seatGates') }
  /** Register installed code, never source-provided expressions.
   * @param criterion - typed evaluator with validated parameter ownership.
   * @returns disposer that removes the contribution.
   */
  abstract register(criterion: GateCriterion): () => void
  /** Evaluate order/id deterministically and commit each stable call's hit once.
   * @param context - executor-owned facts and invocation identity.
   * @returns ordered decisions; deny may short-circuit subsequent gates.
   */
  abstract evaluate(context: GateContext): Promise<readonly GateResult[]>
  /** Read hit counts and expiry by revision.
   * @param request - bounded gate filters.
   * @returns committed counter page.
   */
  abstract list(request: T.ListSeatGatesRequest): Promise<T.ListSeatGatesResult>
  /** Verify explicit worktree registration without scanning unrelated directories.
   * @param request - tree, policy identity and optional authorized force.
   * @returns registration or executable alternatives.
   */
  abstract registerWorktree(request: T.RegisterSeatWorktreeRequest): Promise<T.SeatWorktreeResult>
  /** Publish cleanup suggestions without deleting or committing any tree.
   * @param request - authenticated task settlement fact.
   * @returns affected trees and safe alternatives.
   */
  abstract onTaskEnded(request: T.SeatTaskEndedRequest): Promise<T.SeatWorktreeResult>
}

/** Additional-root tools retain filesystem permission checks and do not widen shell write policy. */
export abstract class SeatDirectoryService extends Service {
  constructor(ctx: Context) { super(ctx, 'seatDirectories') }
  /** Enumerate only roots authorized for this binding.
   * @param sessionId - trusted caller Session.
   * @returns registered roots and effective writability.
   */
  abstract roots(sessionId: SessionId): Promise<readonly T.SeatDirectoryRoot[]>
  /** Read within a registered root with explicit truncation.
   * @param request - root identity, relative path and byte bound.
   * @returns bounded content or a filesystem refusal.
   */
  abstract read(request: T.SeatDirectoryReadRequest): Promise<T.SeatDirectoryReadResult>
  /** Write only after memory ownership and provider permission admission.
   * @param request - registered root and attributed content.
   * @returns committed write or a refusal without permission escalation.
   */
  abstract write(request: T.SeatDirectoryWriteRequest): Promise<T.SeatDirectoryWriteResult>
  /** Apply an exact edit under the same policy as write.
   * @param request - root identity and old/new content.
   * @returns committed edit or a match/permission refusal.
   */
  abstract edit(request: T.SeatDirectoryEditRequest): Promise<T.SeatDirectoryWriteResult>
}

export default SeatService
