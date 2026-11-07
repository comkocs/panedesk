/** Process-local authorization types retained for journal replay and cross-package references.
 * No issuer, transaction, or grant is constructed here; old frames stay readable.
 */
import type { Branded } from '@panedesk/dsh-brand'
import type { EngineDecisionId, EngineEffect } from './events.ts'
import type {
  ApprovePendingSeatRequest, AuthorizationRef, PendingSeatMutationResult,
  SeatAuthorizationQueryRequest, SeatAuthorizationQueryResult, SeatDigest,
  SeatEngineOperationResult, SeatIssuedAuthorizationFact, SeatIssuedAuthorizationKind,
  SeatOperationId, SeatRejected,
} from './types.ts'

declare const issuedAuthorization: unique symbol

/** Only the trusted entry's issuer creates this process-local grant; JSON cannot restore it. */
export interface SeatAuthorizationGrant {
  readonly [issuedAuthorization]: true
  readonly fact: Readonly<SeatIssuedAuthorizationFact>
}
/** The entry captures kind, principal, binding and origin; callers supply only action evidence. */
export interface SeatAuthorizationCheck {
  readonly operationId: SeatOperationId
  readonly requestDigest: SeatDigest
  readonly callId?: Branded<'ToolCallId'>
  readonly rootCallId?: Branded<'ToolCallId'>
}
/** A provider-owned closure captures an authenticated entry, not a principal-name heuristic. */
export interface SeatAuthorizationIssuer {
  /** Recheck live authority and policy; kind is never inferred from principalId or origin.
   * Human, operator, engine, plugin and model entries obtain distinct host-owned issuers.
   * Call IDs must match captured invocation evidence; denied checks still produce audit grants.
   * @param request - Stable action identity and canonical digest, without caller-defined attribution.
   * @returns An entry-issued allowed/denied fact, or refusal when evidence cannot be issued.
   */
  check(request: SeatAuthorizationCheck): Promise<SeatAuthorizationGrant | SeatRejected>
}
/** One synchronous builder prepares facts only; it must not execute external side effects. */
export interface SeatAuthorizedAction {
  readonly authorization: SeatAuthorizationGrant
  readonly effects: readonly EngineEffect[]
}
/** CAS binds the action and its authorization to the same latest journal state. */
export interface SeatAuthorizationTransactionRequest extends SeatAuthorizationCheck {
  readonly decisionId: EngineDecisionId
  readonly expectedSequence: number
}
/** A commit receipt is evidence, not permission to replay an action after policy changes. */
export type SeatAuthorizationTransactionResult =
  | {
    readonly status: 'committed'
    readonly decisionId: EngineDecisionId
    readonly sequence: number
    readonly authorizationId: AuthorizationRef
    readonly operationId: SeatOperationId
  }
  | { readonly status: 'conflict'; readonly sequence: number }
  | SeatRejected
/** Filters include plugin attribution without widening the legacy query or durable event union. */
export interface SeatIssuedAuthorizationQueryRequest extends Omit<SeatAuthorizationQueryRequest, 'kind'> {
  kind?: SeatIssuedAuthorizationKind
}
/** Legacy records retain unknown attribution rather than acquiring guessed kinds. */
export interface SeatIssuedAuthorizationQueryResult extends Omit<SeatAuthorizationQueryResult, 'facts'> {
  facts: readonly SeatIssuedAuthorizationFact[]
}
/** Installed only with a compatible journal writer, replay validator and query projection. */
export interface SeatAuthorizationTransactions {
  /** Revalidate current ownership before resuming an already admitted external action.
   * This check is not a commit receipt and cannot replace transactional intent admission.
   * @param request - Exact original operation and causal evidence.
   * @param authorization - Live entry-owned grant, never a historical fact.
   * @returns Null for current allowed authority, otherwise a structured refusal.
   */
  validate?(request: SeatAuthorizationCheck, authorization: SeatAuthorizationGrant): Promise<SeatRejected | null>
  /** Commit authorization and action effects in one engine decision, never a second audit store.
   * The synchronous builder runs under existing journal serialization after the sequence CAS.
   * Validate grant ownership/current policy and exact operation/digest/call correlation before commit.
   * Allowed actions require matching intent effects; denied facts must not admit action effects.
   * Same decision/operation/call identity and digest returns the original receipt; mismatch rejects.
   * Fsync failure prevents dispatch; ambiguous writes require recovery, never blind resubmission.
   * Reader capability must be negotiated before writing; legacy readers must refuse unknown facts.
   * @param request - Stable decision and action identity with the expected committed sequence.
   * @param build - Synchronous preparation of one issued fact and its corresponding action effects.
   * @returns Durable receipt, sequence conflict or refusal; no result authorizes a second execution.
   */
  transact(request: SeatAuthorizationTransactionRequest, build: () => SeatAuthorizedAction): Promise<SeatAuthorizationTransactionResult>
  /** Use the original approval transition, committing its issued fact in the same decision.
   * Recheck queue revision and grant policy under journal serialization; do not call legacy
   * approve() after a separate audit commit. Missing capability refuses rather than bypassing it.
   * @param request - Original pending identity, expected version and operation identity.
   * @param authorization - Entry-issued exact-operation grant; attribution is never inferred.
   * @returns Original approval/conflict/refusal after the combined decision is durable.
   */
  approve(request: ApprovePendingSeatRequest, authorization: SeatAuthorizationGrant): Promise<PendingSeatMutationResult>
  /** Cancel pending work and commit its issued attribution in the same decision.
   * @param request - Exact queue revision, operation identity and optional bounded reason.
   * @param authorization - Entry-issued grant covering the target seat and tasks.
   * @returns Original mutation reply or a structured lifecycle refusal.
   */
  cancel?(request: import('./types.ts').CancelPendingSeatRequest, authorization: SeatAuthorizationGrant): Promise<PendingSeatMutationResult>
  /** Rebuild the same redacted projection on restart, without reading process-local grant objects.
   * @param request - Authorized task, seat, kind and time filters with an exclusive cursor.
   * @returns Matching facts once each, scanned watermark and explicit completeness or refusal.
   */
  query(request: SeatIssuedAuthorizationQueryRequest): Promise<SeatIssuedAuthorizationQueryResult | SeatRejected>
  /** Read durable operation progress without admitting or retrying any action.
   * @param request - Stable operation identity.
   * @returns Registration and latest correlated progress, or missing when no fact exists.
   */
  operation?(request: import('./types.ts').SeatOperationQuery): Promise<SeatEngineOperationResult>
}

/** Separate JSON export includes issued kinds without widening legacy engine effects. */
export interface SeatAuthorizationExports {
  /** Export one bounded page with its physical cursor and committed watermark.
   * @param request - Issued attribution filters and page bound.
   * @returns Versioned JSON page or a structured refusal; grants are never exported.
   */
  export(request: SeatIssuedAuthorizationQueryRequest): Promise<{
    format: 'seat-authorization/v1'
    content: string
    complete: boolean
    watermark: number
  } | SeatRejected>
}

/** Host-only registration captures authenticated attribution and a synchronous live-policy check. */
export interface SeatAuthorizationEntry {
  readonly identity: Omit<SeatIssuedAuthorizationFact, 'authorizationId' | 'operationId' | 'requestDigest' | 'checkedAt' | 'decision' | 'reasonCode'>
  /** Recheck the captured entry without asynchronous work inside the journal builder.
   * @returns Current policy outcome; null revokes the entry.
   */
  current(): { decision: 'allowed' | 'denied'; reasonCode: string; policyRevision: number } | null
}
/** Available only to trusted in-process adapters, never exposed as a wire method. */
export interface SeatAuthorizationIssuers {
  /** Capture one authenticated entry; request JSON must never supply this registration.
   * @param entry - Host-owned identity and live-policy closure.
   * @returns Issuer and revocation disposer.
   */
  register(entry: SeatAuthorizationEntry): { issuer: SeatAuthorizationIssuer; dispose(): void }
}

declare module './types.ts' {
  interface SeatCallContext {
    /** Entry-issued attribution for atomic local admission; omission preserves the legacy path.
     * Receivers must verify issuer ownership and action correlation, not just this field's presence.
     * Never serialize this process-local grant into a request or reconstruct it from principalId.
     */
    authorization?: SeatAuthorizationGrant
    /** Host-only local wake entry. Both grants are required; dropping either never selects legacy admission. */
    localWake?: { readonly opening: SeatAuthorizationGrant }
  }
}

/** Optional engine actions preserve their original admission builders and attach issued authority. */
export interface SeatAuthorizedEngineActions {
  /** Cancel only while the queue item remains undispatched.
   * @param request - Exact queue revision and optional cancellation reason.
   * @param authorization - Entry-issued grant for this operation.
   * @returns Revision-checked cancellation or structured refusal.
   */
  cancel?(request: import('./types.ts').CancelPendingSeatRequest, authorization: SeatAuthorizationGrant): Promise<PendingSeatMutationResult>
  /** Renew only after the attempt and authorization commit together.
   * @param request - Original renewal input.
   * @param authorization - Entry-issued grant for the exact input.
   * @returns Original maintenance result or admission refusal.
   */
  renew(request: import('./types.ts').RenewSeatRequest, authorization: SeatAuthorizationGrant): Promise<import('./types.ts').RenewSeatResult>
  /** Queue replacement and authorization in one decision without acquiring a second owner.
   * @param request - Original replacement input.
   * @param authorization - Entry-issued grant for the exact input.
   * @returns Original replacement result or admission refusal.
   */
  replace(request: import('./types.ts').ReplaceSeatRequest, authorization: SeatAuthorizationGrant): Promise<import('./types.ts').ReplaceSeatResult>
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Missing capability rejects new audited actions; legacy local entry points remain unchanged. */
    seatAuthorizationTransactions: SeatAuthorizationTransactions
    /** Independent issued-fact export; legacy engine exports retain their closed effect vocabulary. */
    seatAuthorizationExports: SeatAuthorizationExports
    /** Optional audited engine actions; absence refuses requests carrying grants. */
    seatAuthorizedEngineActions: SeatAuthorizedEngineActions
    /** Host-only issuer registration; never forward registration arguments from request JSON. */
    seatAuthorizationIssuers: SeatAuthorizationIssuers
  }
}
