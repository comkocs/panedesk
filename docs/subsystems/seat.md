# Seat orchestration

English | [中文](seat.zh.md)

This page owns the types and service semantics declared by the [seat package group](../../packages/seat/README.md). Providers and consumers remain optional; the [application bundle](../../packages/seat/seat-app/README.md) owns explicit composition.

## Identity and authority

`SeatName` identifies a node-local definition; `SeatOperationId` identifies a caller-retained operation. Session identity remains the upstream `SessionId`. `SeatCallContext` contains authenticated principal, origin, and node identity supplied by a trusted adapter, not accepted as request authority. `SeatBinding` is engine metadata beside the Session log, with distinct free and seat variants.

## Definitions and admission

`SeatDefinition` freezes its revision, startup and additional directories, opening text, model and permission selections, subscriptions, checkpoint files, rules, and local capacity. Import previews retain source and mapping digests; committing selected rows checks both the original source and catalog revision. Source authority changes only through an authorized operation.

`SeatProjectPolicy` defaults to reminder mode until explicitly selected. Rules cannot widen project policy. `SeatQueued` reports FIFO identity and blocking reasons without claiming resources. `ChildAdmissionTicket` represents nonblocking child admission; cancelling an unstarted ticket does not terminate a running child. `SeatTurnAdmission` defers only a new turn and leaves queued input intact.

## Window operations

`OpenSeatResult` distinguishes opened, prefilled, existing-window choices, switched, cancelled, queued, and rejected outcomes. Creation does not imply first-turn completion. `ReplaceSeatResult` preserves old and new identities and cleanup state; replacement opens new before closing old and retains an explicit handover permit. `CloseSeatResult` distinguishes closed, busy, version conflict, and refusal. Unknown activity is not idle evidence.

`SeatWindowView` projects runtime state, busy reasons, cache evidence, and state version. `SeatContextUsage` represents dated current-context evidence, not accumulated accounting tokens. Missing evidence remains unknown. `SeatFailure` carries a machine code, explanation, alternative, retryability, and observed effect state.

## Engine records and queries

`EngineDecision` commits one bounded frame containing typed `EngineEffect` records under writer ownership and expected-sequence comparison. The engine journal is separate from Session, accounting, and message journals. Callbacks use stable identities and at-least-once outbox delivery; recovery does not replay uncertain model effects.

`EngineCursor` advances exclusively by node, sequence, and effect index. Query time ranges are half-open; results expose completeness and a committed watermark. Export is redacted unless independently authorized. Verification never executes imported operations. `SeatBudgetSnapshot` preserves unknown cost instead of treating it as zero; `MicroUsd` uses decimal integer micro-USD.

## Issued authorization and node admission

`SeatAuthorizationEntry` captures host-authenticated attribution and current policy. `SeatAuthorizationIssuer` returns process-local `SeatAuthorizationGrant` values bound to `SeatAuthorizationCheck`; wire data cannot recreate them. `SeatAuthorizedAction` combines the grant with matching intent effects. `SeatAuthorizationTransactionRequest` adds the expected sequence and decision identity; `SeatAuthorizationTransactionResult` reports a durable commit, sequence conflict, or refusal. `SeatIssuedAuthorizationQueryRequest` and `SeatIssuedAuthorizationQueryResult` include plugin facts without widening legacy engine effects. Exported facts are evidence, not executable authority; historical records without attribution remain unknown.

`NodePreparedRequest` retains method/result correlation and sender-frozen message identity. `NodeDelegationRequest` omits delegation until a trusted issuer creates a `NodeDelegationResult`. `NodeAuthenticatedPeer` comes from transport authentication; receiving policy intersects retained original authority, configured peer permissions, expiry, and current local admission. `NodeLinkFailure` preserves safe refusals. `ApprovePendingSeatRequest`, `PendingSeatMutationResult`, and `SeatRejected` retain the original approval and refusal semantics. Missing services do not grant authority or enable another routing hop.

`HostSdkInvocation` identifies a registered namespace method and its untrusted parameters. `HostSdkIdentity` carries only host-issued principal, optional Session and seat attribution, and a revocation signal; request fields cannot supply that identity. `HostSdkResult` separates an encoded JSON value from a safe rejection. `HostSessionBinding` supplies trusted Session and seat facts to the credential issuer; `HostSessionCredential` returns owner-only endpoint and credential paths with awaited revocation. These services remain absent when their optional providers are not installed.

`SeatEngineOperationResult` preserves the existing operation status while adding optional approval registration and correlated pending/open/cancelled progress. `HostAdminQueryRequest` uses separate effect and authorization cursors; `HostAdminQueryResult` carries redacted effects and an independently bounded issued-authorization page. Neither historical facts nor queries grant execution authority.

## Waits, reports, and policies

`SeatWait` registers any/all observations of explicit subagent, job, schedule, or message objects, returning before completion. Cancellation affects observation only. `CloseSelfReport` records close intent, outstanding work, and next-open prerequisites without changing runtime status.

`GateDefinition` selects an installed criterion, hook, revision, ordering, and expiration. `GateContext` contains executor-owned facts; `GateResult` preserves allow, deny, or not-applicable outcomes and audit state. `SeatWorktreeHost` owns revision-checked persistence and force authorization; `SeatReminderHost` owns child threshold delivery. Neither an operation string nor model text supplies authorization.

## Cordis API

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhostadmin--hostadminservice"></a>

### `ctx.hostAdmin` — `HostAdminService`

Administration is optional and never starts a second engine to answer a query.

```ts cordis-catalog
/** Dispatch a fixed method after transport authentication and epoch validation.
 * @param request - Bounded validated request without caller-defined authority.
 * @param authority - Authenticated operator role narrowed to permitted methods.
 * @returns Provider evidence; approval records authorization before engine admission.
 */
dispatch(request: HostAdminRequest, authority: HostAdminAuthority): Promise<HostAdminResponse>
```

Source: [`packages/host/host-admin/src/index.ts`](../../packages/host/host-admin/src/index.ts)

<a id="ctxhostadminexecutor--hostadminexecutor"></a>

### `ctx.hostAdminExecutor` — `HostAdminExecutor`

Local executors own authorization facts and must durably record approval before admission.

```ts cordis-catalog
/** Invoke only a locally authenticated capability, never another router.
 * @param request - Validated fixed-method request.
 * @param authority - Transport-derived narrowed authority.
 * @returns Provider evidence after required authorization persistence.
 */
execute(request: HostAdminRequest, authority: HostAdminAuthority): Promise<HostAdminResponse>
```

Source: [`packages/host/host-admin/src/index.ts`](../../packages/host/host-admin/src/index.ts)

<a id="ctxhostsdkinvoker--hostsdkinvoker"></a>

### `ctx.hostSdkInvoker` — `HostSdkInvoker`

The SDK registry provider supplies this optional adapter without starting stdio.

```ts cordis-catalog
/** Decode, authorize, invoke and encode through the registered namespace.
 * @param request - Validated namespace and method with untrusted method parameters.
 * @param identity - Host-issued caller identity and revocation signal.
 * @returns Encoded result or safe rejection without provider diagnostics.
 */
invoke(request: HostSdkInvocation, identity: HostSdkIdentity): Promise<HostSdkResult>
```

Source: [`packages/host/host-admin/src/sdk.ts`](../../packages/host/host-admin/src/sdk.ts)

<a id="ctxhostsessioncredentials--hostsessioncredentials"></a>

### `ctx.hostSessionCredentials` — `HostSessionCredentials`

Optional host-owned issuance; callers supply trusted creation facts, never wire fields.

```ts cordis-catalog
/** Replace any earlier credential for this session and publish owner-only files.
 * @param binding - Trusted session creation binding.
 * @returns Paths and an idempotent awaited revocation capability.
 */
issue(binding: HostSessionBinding): Promise<HostSessionCredential>

/** Revoke a closed or replaced session before acknowledging closure.
 * @param sessionId - Host-owned session identity.
 */
revoke(sessionId: HostSessionBinding['sessionId']): Promise<void>
```

Source: [`packages/host/host-admin/src/sdk.ts`](../../packages/host/host-admin/src/sdk.ts)

<a id="ctxnodeauthorizedlocaladmission--nodeauthorizedlocaladmission"></a>

### `ctx.nodeAuthorizedLocalAdmission` — `NodeAuthorizedLocalAdmission`

Local admission is explicitly supplied by the journal-owning provider, never synthesized by transport.

```ts cordis-catalog
/** Commit the exact grant with the original action intent before dispatching local effects.
 * @param request - Single-hop operation already checked against the local target.
 * @param authorization - Entry-issued, process-local grant with exact operation evidence.
 * @returns Correlated local result after atomic admission; no rerouting is permitted.
 */
execute(request: NodePreparedRequest, authorization: Seat.SeatAuthorizationGrant): Promise<NodeWireResponse>
```

Source: [`packages/seat/node-link/src/execution.ts`](../../packages/seat/node-link/src/execution.ts)

<a id="ctxnodedelegationissuer--nodedelegationissuer"></a>

### `ctx.nodeDelegationIssuer` — `NodeDelegationIssuer`

Host entry captures original authority and signs or retains evidence bound to the exact method.

```ts cordis-catalog
/** Verify live entry authority, binding, method and target before issuing a single-hop delegation.
 * Capture original kind through its trusted issuer, never principalId/origin string inference.
 * Bind method, payload digest, operation, source/target and call causality to retained evidence.
 * Expiry cannot exceed request.deadline, original authority expiry or configured lifetime;
 * skew never extends the signed deadline. Retry keeps identity/digest, not expired authority.
 * Missing issuer retains cross-node-unsupported or a safe authorization refusal before route().
 * @param request - Prepared request without caller-supplied delegation or role.
 * @returns Narrow delegation or refusal; authorizationRef is an audit reference, not a bearer.
 */
issue(request: NodeDelegationRequest): Promise<NodeDelegationResult>
```

Source: [`packages/seat/node-link/src/delegation.ts`](../../packages/seat/node-link/src/delegation.ts)

<a id="ctxnodedelegationreceivingpolicy--nodedelegationreceivingpolicy"></a>

### `ctx.nodeDelegationReceivingPolicy` — `NodeDelegationReceivingPolicy`

Receiving policy intersects original rights, peer allowlist and current local target permissions.

```ts cordis-catalog
/** Validate authenticated peer, hop=1, local target, expiry, digest and retained issuer evidence.
 * Reject missing mappings and privilege amplification, including free-session write escalation.
 * Returned issuer is bound to this operation and locally records node-delegation attribution;
 * delegatedBy retains the sender's original authorization reference, not its local operator role.
 * @param request - Fully decoded request, including sender-frozen message identity when sending.
 * @param peer - Transport-owned node evidence; matching request strings are insufficient.
 * @returns Local exact-operation issuer or refusal, never permission for another routing hop.
 */
authorize(request: NodePreparedRequest, peer: NodeAuthenticatedPeer): Promise<Seat.SeatAuthorizationIssuer | NodeLinkFailure>
```

Source: [`packages/seat/node-link/src/delegation.ts`](../../packages/seat/node-link/src/delegation.ts)

<a id="ctxnodelinkexecutor--nodelinkexecutor"></a>

### `ctx.nodeLinkExecutor` — `NodeLinkExecutor`

Local provider narrows authenticated node delegations and never calls a router again.

```ts cordis-catalog
/** Check the current binding, principal, target and method rights on the receiving node.
 * @param request - Validated request authenticated to its configured source node.
 * @returns Whether current local policy permits this exact delegation.
 */
authorize(request: NodeWireRequest): Promise<boolean>

/** Execute through the original local provider after durable transport admission.
 * @param request - Authorized fixed-method operation.
 * @returns Correlated local provider result.
 */
execute(request: NodeWireRequest): Promise<NodeWireResponse>

/** Observe current local capacity without starting an engine.
 * @returns Local node self-report.
 */
status(): Promise<Seat.SeatNodeStatus>
```

Source: [`packages/seat/node-link/src/index.ts`](../../packages/seat/node-link/src/index.ts)

<a id="ctxnoderouter--noderouterservice"></a>

### `ctx.nodeRouter` — `NodeRouterService`

Receiver invokes local providers only; delegation is authenticated again and cannot add hops.

```ts cordis-catalog
/** Route one bounded authenticated request without offline user-operation queues.
 * @param request - Fixed method, digest, deadline and narrowed delegation.
 * @returns Target result or explicit unknown outcome retaining operation identity.
 */
route(request: NodeWireRequest): Promise<NodeWireResponse>

/** Read dated health without initiating a model or opening a window.
 * @returns Node aliases and explicit stale/unreachable evidence.
 */
status(): Promise<readonly NodeLinkStatus[]>
```

Source: [`packages/seat/node-link/src/index.ts`](../../packages/seat/node-link/src/index.ts)

<a id="ctxseatauthorizationexports--seatauthorizationexports"></a>

### `ctx.seatAuthorizationExports` — `SeatAuthorizationExports`

Separate JSON export includes issued kinds without widening legacy engine effects.

```ts cordis-catalog
/** Export one bounded page with its physical cursor and committed watermark.
 * @param request - Issued attribution filters and page bound.
 * @returns Versioned JSON page or a structured refusal; grants are never exported.
 */
export(request: SeatIssuedAuthorizationQueryRequest): Promise<{ format: 'seat-authorization/v1' content: string complete: boolean watermark: number } | SeatRejected>
```

Source: [`packages/seat/seat/src/authorization.ts`](../../packages/seat/seat/src/authorization.ts)

<a id="ctxseatauthorizationissuers--seatauthorizationissuers"></a>

### `ctx.seatAuthorizationIssuers` — `SeatAuthorizationIssuers`

Available only to trusted in-process adapters, never exposed as a wire method.

```ts cordis-catalog
/** Capture one authenticated entry; request JSON must never supply this registration.
 * @param entry - Host-owned identity and live-policy closure.
 * @returns Issuer and revocation disposer.
 */
register(entry: SeatAuthorizationEntry): { issuer: SeatAuthorizationIssuer; dispose(): void }
```

Source: [`packages/seat/seat/src/authorization.ts`](../../packages/seat/seat/src/authorization.ts)

<a id="ctxseatauthorizationqueries--seatauthorizationqueries"></a>

### `ctx.seatAuthorizationQueries` — `SeatAuthorizationQueries`

Read-only authorization projection definition; it does not enable a new ledger writer.

```ts cordis-catalog
/** Read committed authorization facts without treating them as reusable capabilities.
 * @param request - Authorized task, seat and time filters.
 * @returns Redacted facts with watermark or a structured refusal.
 */
query(request: T.SeatAuthorizationQueryRequest): Promise<T.SeatAuthorizationQueryResult | T.SeatRejected>

/** Read engine facts by task without changing the legacy query method.
 * @param request - Task filter and existing pagination fields.
 * @returns Committed matching effects or a structured refusal.
 */
tasks(request: T.SeatTaskQueryRequest): Promise<T.EngineQueryResult | T.SeatRejected>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatauthorizationtransactions--seatauthorizationtransactions"></a>

### `ctx.seatAuthorizationTransactions` — `SeatAuthorizationTransactions`

Installed only with a compatible journal writer, replay validator and query projection.

```ts cordis-catalog
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
```

Source: [`packages/seat/seat/src/authorization.ts`](../../packages/seat/seat/src/authorization.ts)

<a id="ctxseatauthorizedengineactions--seatauthorizedengineactions"></a>

### `ctx.seatAuthorizedEngineActions` — `SeatAuthorizedEngineActions`

Optional engine actions preserve their original admission builders and attach issued authority.

```ts cordis-catalog
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
```

Source: [`packages/seat/seat/src/authorization.ts`](../../packages/seat/seat/src/authorization.ts)

<a id="ctxseatdirectories--seatdirectoryservice-abstract-seam"></a>

### `ctx.seatDirectories` — `SeatDirectoryService` (abstract seam)

Additional-root tools retain filesystem permission checks and do not widen shell write policy.

```ts cordis-catalog
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
```

Types: [SessionId](core.md)

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatengine--seatengineservice-abstract-seam"></a>

### `ctx.seatEngine` — `SeatEngineService` (abstract seam)

Engine owns the journal, queues, resources and outbox; local providers depend only on this definition.

```ts cordis-catalog
/** Commit ingress before acknowledging acceptance.
 * @param envelope - authenticated bounded source event.
 * @returns stable accepted, duplicate, coalesced or rejected identity.
 */
abstract accept(envelope: T.TriggerEnvelope): Promise<T.AcceptTriggerResult>

/** Commit frozen admission and its live grant together; never route again.
 * @param request - Frozen source input, route and expected local definition revision.
 * @param authority - Independently verified process-local authority with the exact grant.
 * @returns Durable acceptance or refusal without source-side execution resources.
 */
acceptFrozen?(request: T.AcceptFrozenTriggerRequest, authority: T.SeatCallContext): Promise<T.AcceptFrozenTriggerResult>

/** Install the local Session executor without coupling engine storage to its implementation.
 * @param executor - trusted local implementation.
 * @returns disposer that drains in-flight recovery before detaching.
 */
abstract registerExecutor(executor: T.SeatOpenExecutor): () => Promise<void>

/** Queue a replacement without bypassing either window's capacity.
 * @param request - old window and retained transaction identity.
 * @returns the durable replacement state.
 */
abstract replace(request: T.ReplaceSeatRequest): Promise<T.ReplaceSeatResult>

/** Commit a flushed close together with release and source callbacks.
 * @param closed - provider-confirmed archive, title and flush result.
 * @returns after all close facts are durable.
 */
abstract recordClosed(closed: import('./events.ts').EngineCloseData): Promise<void>

/** Use the same durable maintenance path as automatic renewal, marked as manual.
 * @param request - local window and caller-retained operation identity.
 * @returns renewed, rejected or uncertain without conversation content.
 */
abstract renew(request: T.RenewSeatRequest): Promise<T.RenewSeatResult>

/** Reevaluate pending work and original open identities.
 * @returns after the current reconciliation batch settles.
 */
abstract drive(): Promise<void>

/** Admit a child through the parent's persistent FIFO capacity.
 * @param request - frozen ticket and resolved parent limit.
 * @returns durable queued or admitted ticket.
 */
abstract admitChild(request: T.AdmitSeatChildRequest): Promise<T.ChildAdmissionResult>

/** Release a settled child and wake queued admission.
 * @param ticketId - original admission identity.
 * @returns after release is durable.
 */
abstract releaseChild(ticketId: T.ChildTicketId): Promise<void>

/** Check a new turn before inbox claim; never interrupts an existing turn.
 * @param sessionId - exact window identity.
 * @returns allow or a durable-policy deferral.
 */
abstract admitTurn(sessionId: SessionId): Promise<T.SeatTurnAdmission>

/** Commit a rejected external-source attempt without admitting it to the opening queue.
 * @param request - bounded source identity, body digest, observation time and sanitized failure.
 * @returns only after the source/rejected audit fact is durable; storage failures reject.
 */
abstract auditSourceRejection(request: { sourceId: T.SeatSourceId digest: T.SeatDigest observedAt: T.SeatTimestamp error: T.SeatFailure }): Promise<void>

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
```

Types: [SessionId](core.md)

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatenginequery--seatenginequeryservice-abstract-seam"></a>

### `ctx.seatEngineQuery` — `SeatEngineQueryService` (abstract seam)

Offline observations never acquire ownership, repair storage or start runtime drivers.

```ts cordis-catalog
/** Read verified facts through the last complete frame.
 * @param request - bounded filters and exclusive cursor.
 * @returns facts and watermark, or a structured storage refusal.
 */
abstract query(request: T.EngineQueryRequest): Promise<T.EngineQueryResult | T.SeatRejected>

/** Rebuild pending work without activating it.
 * @param request - bounded pending filters.
 * @returns redacted pending page or a structured storage refusal.
 */
abstract pending(request: T.ListPendingSeatsRequest): Promise<T.ListPendingSeatsResult | T.SeatRejected>

/** Return JSONL content in memory; the requested output path is never written.
 * @param request - selection and explicit raw-data authorization.
 * @returns content, digest and coverage, or a structured storage refusal.
 */
abstract export(request: T.EngineExportRequest): Promise<(Extract<T.EngineExportResult, { status: 'exported' }> & { content: string; complete: boolean }) | T.SeatRejected>

/** Verify a file without importing or repairing it.
 * @param request - explicit input file.
 * @returns framing integrity or a structured storage refusal.
 */
abstract verify(request: T.EngineVerifyRequest): Promise<T.EngineVerifyResult>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatgates--seatgateservice-abstract-seam"></a>

### `ctx.seatGates` — `SeatGateService` (abstract seam)

Registry provider owns deterministic evaluation, durable hit counts and expiration.

```ts cordis-catalog
/** Read the node policy clock's IANA time zone, independently of rule and budget zones.
 * @returns configured node time zone, or UTC when no override is supplied.
 */
getTimeZone(): string

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

/** Optional batch scope preflight; absence must not downgrade task batches to concurrency without evidence.
 * @param context - Complete task, node, seat and scope evidence.
 * @returns Conservative intersection decision and serial alternative.
 */
evaluateTaskScopes?(context: import('./gates.ts').TaskScopeBatchGateContext): Promise<import('./gates.ts').TaskScopeGateDecision>

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

/** Emit one durable next-step handoff reminder per child context epoch and threshold revision.
 * @param request - child-owned context evidence and bounded handoff summary.
 * @returns observable delivery or evidence status; never changes notice semantics.
 */
abstract remindChild(request: import('./gates.ts').SeatChildThresholdRequest): Promise<'sent' | 'below' | 'unknown' | 'unavailable'>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatgatesquery--seatgatesqueryservice-abstract-seam"></a>

### `ctx.seatGatesQuery` — `SeatGatesQueryService` (abstract seam)

Offline gate observations never evaluate policies or acquire engine ownership.

```ts cordis-catalog
/** Rebuild recorded gate revisions without inventing unrecorded policies or limits.
 * @param request - bounded gate filters and snapshot-relative cursor.
 * @returns recorded counters, expiry and limit evidence, or a structured refusal.
 */
abstract list(request: T.ListSeatGatesRequest): Promise<import('./gates.ts').SeatGatesQueryResult | T.SeatRejected>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatlocalcreation--localseatcreation"></a>

### `ctx.seatLocalCreation` — `LocalSeatCreation`

Trusted adapters scope one confirmed traditional creation, never wire-provided identity.

```ts cordis-catalog
/** Retain a single-use choice for the authenticated caller.
 * @param cwd - requested directory.
 * @param authority - adapter-authenticated caller.
 * @returns one-use traditional confirmation.
 */
confirmTraditional(cwd: string, authority: T.SeatCallContext): Promise<T.DirectoryConfirmation>

/** Execute a traditional create using a previously confirmed choice.
 * @param confirmation - retained single-use capability.
 * @param authority - authenticated adapter caller.
 * @param create - upstream creation operation.
 * @returns upstream result unchanged.
 */
run<R>(confirmation: T.DirectoryConfirmation, authority: T.SeatCallContext, create: () => Promise<R>): Promise<R>
```

Source: [`packages/seat/seat-local/src/create-admission.ts`](../../packages/seat/seat-local/src/create-admission.ts)

<a id="ctxseatlocalread--seatlocalreadaccess"></a>

### `ctx.seatLocalRead` — `SeatLocalReadAccess`

Provider-owned read capabilities for trusted in-process gates and tools, never remote adapters. External SeatService calls still require explicit authority; no mutation facade is exposed.

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatlocalsession--seatlocalsessionaccess"></a>

### `ctx.seatLocalSession` — `SeatLocalSessionAccess`

Provider-owned authorization for tools; read capabilities never grant mutation authority.

```ts cordis-catalog
/** Capture the live Session object supplied by the tool executor.
 * @param session - registered calling Session, not a model-supplied identifier.
 * @returns four operations that reject targets outside this Session.
 */
forSession(session: import('@panedesk/dsh-session').Session): SeatSessionOperations
```

Types: [Session](session.md)

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatlocalwindows--seatlocalwindowsaccess"></a>

### `ctx.seatLocalWindows` — `SeatLocalWindowsAccess`

Provider-owned authorization for explicitly selected windows on this node.

```ts cordis-catalog
/** Capture the executor's live Session and tool call, not a target window identity.
 * @param invocation - trusted executor context; the Session must remain registered.
 * @returns six operations stamped with this invocation's stable operation identity.
 */
forInvocation(invocation: { session: import('@panedesk/dsh-session').Session callId: import('@panedesk/dsh-brand').Branded<'ToolCallId'> }): SeatWindowOperations
```

Types: [Session](session.md) · [ToolCallId](core.md)

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatopeningcontexts--seatopeningcontexts"></a>

### `ctx.seatOpeningContexts` — `SeatOpeningContexts`

Optional opening service definition; no provider is installed by this module.

```ts cordis-catalog
/** Prepare and retain input at the sole source owner without waiting for execution.
 * @param request - Exact source, epoch, task and operation identities.
 * @param authority - Authenticated original caller.
 * @returns Frozen input and reservation or refusal.
 */
prepare?(request: T.PrepareSourceOpeningRequest, authority: T.SeatCallContext): Promise<T.PrepareSourceOpeningResult>

/** Recheck an exact retained reservation without reading source text again.
 * @param request - Original reservation and actual execution node.
 * @param authority - Authenticated restricted caller.
 * @returns Current permission; unknown retains occupancy.
 */
checkAdmission?(request: T.CheckSourceAdmissionRequest, authority: T.SeatCallContext): Promise<T.CheckSourceAdmissionResult>

/** Retain a callback before performing source-owned writeback steps.
 * @param request - Original callback, route and frozen runtime evidence.
 * @param authority - Authenticated execution-node identity.
 * @returns Committed only after all original steps finish.
 */
deliverCallback?(request: T.DeliverSourceCallbackRequest, authority: T.SeatCallContext): Promise<T.DeliverSourceCallbackResult>

/** Install one trusted scope owner; omission retains the existing scope evaluation.
 * @param admission - Owner of serialized checks and durable reservations.
 * @returns Disposer that stops new calls and drains active admissions.
 */
registerScopeAdmission?(admission: T.OpeningScopeAdmission): () => Promise<void>

/** Register trusted resolver code through a Cordis effect.
 * @param provider - Installed resolver with an exclusive provider identity.
 * @returns Disposer that drains resolutions before removing the provider.
 */
register(provider: T.OpeningContextProvider): () => Promise<void>

/** Open through the existing admission path with a frozen provider reference.
 * @param request - Explicit revision and task associations.
 * @param authority - Authenticated host identity, never wire fields.
 * @returns Existing opening outcomes without bypassing gates or budgets.
 */
open(request: T.OpenSeatWithContextRequest, authority: T.SeatCallContext): Promise<T.OpenSeatResult>

/** Wake an existing window or open through the same trusted context when none exists.
 * @param request - Wake target and revisioned fallback opening reference.
 * @param authority - Authenticated host identity.
 * @returns Original wake outcome without a new opening callback for existing windows.
 */
wake?(request: T.WakeSeatWithContextRequest, authority: T.SeatCallContext): Promise<T.WakeSeatResult>

/** Preflight complete scope evidence before any batch member executes.
 * @param request - Explicit seats and every associated task.
 * @param authority - Authenticated caller.
 * @returns Independent outcomes or a whole-batch preflight refusal.
 */
openBatch(request: T.OpenSeatBatchWithScopeRequest, authority: T.SeatCallContext): Promise<T.OpenSeatBatchResult>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatreminderhost--seatreminderhost"></a>

### `ctx.seatReminderHost` — `SeatReminderHost`

Message delivery owns durable idempotency and maps steer to the existing next-step lane.

```ts cordis-catalog
/** Submit an idempotent reminder to the existing next-step lane.
 * @param request - Target Session, stable delivery identity and reminder content.
 * @returns Durable acceptance or refusal without claiming model completion.
 */
send(request: { sessionId: SessionId; id: string; kind: 'steer'; content: string }): Promise<'accepted' | 'rejected'>
```

Types: [SessionId](core.md)

Source: [`packages/seat/seat/src/gates.ts`](../../packages/seat/seat/src/gates.ts)

<a id="ctxseatremote--seatremote"></a>

### `ctx.seatRemote` — `SeatRemote`

Host owner of the seats namespace; absent providers never activate a replacement runtime.

```ts cordis-catalog
/** Preview source rows without mutating the catalog.
 * @param request - source, mapping and defaults.
 * @returns revision-bound row comparisons.
 */
@Remote('import.preview') async previewImport(request: SeatRequestMap['seats/import.preview']['params']): Promise<SeatRequestMap['seats/import.preview']['result']>

/** Commit selected rows against the original preview revision.
 * @param request - preview identity and row selection.
 * @returns committed revision and row outcomes.
 */
@Remote('import.commit') async commitImport(request: SeatRequestMap['seats/import.commit']['params']): Promise<SeatRequestMap['seats/import.commit']['result']>

/** Transfer editing authority only with independent authorization.
 * @param request - observed revision and authorization reference.
 * @returns committed revision or refusal.
 */
@Remote async setAuthority(request: SeatRequestMap['seats/setAuthority']['params']): Promise<SeatRequestMap['seats/setAuthority']['result']>

/** Record all report fields without asserting runtime idleness.
 * @param request - report and stable operation identity.
 * @returns committed report version.
 */
@Remote('report.submit') async submitReport(request: SeatRequestMap['seats/report.submit']['params']): Promise<SeatRequestMap['seats/report.submit']['result']>

/** Register observations without blocking on task completion.
 * @param request - explicit objects and registration identity.
 * @returns committed wait state.
 */
@Remote('wait.register') async registerWait(request: SeatRequestMap['seats/wait.register']['params']): Promise<SeatRequestMap['seats/wait.register']['result']>

/** Cancel observation without cancelling underlying tasks.
 * @param request - wait identity and observed version.
 * @returns committed wait state.
 */
@Remote('wait.cancel') async cancelWait(request: SeatRequestMap['seats/wait.cancel']['params']): Promise<SeatRequestMap['seats/wait.cancel']['result']>

/** List owner-authorized runtime evidence.
 * @param request - local filters.
 * @returns window page including unopened seats.
 */
@Remote async list(request: SeatRequestMap['seats/list']['params']): Promise<SeatRequestMap['seats/list']['result']>

/** Open through the shared provider, forcing remote automatic opening.
 * @param request - seat and retained operation identity.
 * @returns provider result without waiting for the first model response.
 */
@Remote async open(request: SeatRequestMap['seats/open']['params']): Promise<SeatRequestMap['seats/open']['result']>

/** Open an explicit bounded list without wildcard expansion.
 * @param request - names and operation identity.
 * @returns independent provider outcomes.
 */
@Remote async openBatch(request: SeatRequestMap['seats/openBatch']['params']): Promise<SeatRequestMap['seats/openBatch']['result']>

/** Renew once without conversation text.
 * @param request - local session and stable operation.
 * @returns maintenance evidence.
 */
@Remote async renew(request: SeatRequestMap['seats/renew']['params']): Promise<SeatRequestMap['seats/renew']['result']>

/** Close only at the observed idle version.
 * @param request - local session and version.
 * @returns closed or busy evidence.
 */
@Remote async close(request: SeatRequestMap['seats/close']['params']): Promise<SeatRequestMap['seats/close']['result']>

/** Start a recoverable replacement without closing old first.
 * @param request - old session and stable operation.
 * @returns replacement progress.
 */
@Remote async replace(request: SeatRequestMap['seats/replace']['params']): Promise<SeatRequestMap['seats/replace']['result']>

/** Preserve upstream user-title pinning.
 * @param request - explicit title and local session.
 * @returns committed title.
 */
@Remote async rename(request: SeatRequestMap['seats/rename']['params']): Promise<SeatRequestMap['seats/rename']['result']>

/** Deliver the stored wake text or open an unopened seat.
 * @param request - explicit seat and optional session.
 * @returns delivery or open outcome.
 */
@Remote async wake(request: SeatRequestMap['seats/wake']['params']): Promise<SeatRequestMap['seats/wake']['result']>

/** Read metadata outside the Session log.
 * @param request - local session.
 * @returns binding or absent metadata.
 */
@Remote async binding(request: SeatRequestMap['seats/binding']['params']): Promise<SeatRequestMap['seats/binding']['result']>

/** Observe a pending operation without retrying effects.
 * @param request - operation identity.
 * @returns durable operation state.
 */
@Remote async operation(request: SeatRequestMap['seats/operation']['params']): Promise<SeatRequestMap['seats/operation']['result']>

/** Select project policy with revision comparison.
 * @param request - project, mode and observed revision.
 * @returns the durably committed policy.
 */
@Remote async setProjectMode(request: SeatRequestMap['seats/setProjectMode']['params']): Promise<SeatRequestMap['seats/setProjectMode']['result']>

/** Read pending work without admitting it.
 * @param request - page size and filters.
 * @returns a committed queue page.
 */
@Remote async pending(request: SeatRequestMap['seats/pending']['params']): Promise<SeatRequestMap['seats/pending']['result']>

/** Approve pending work without bypassing admission.
 * @param request - queue item and observed version.
 * @returns the committed approval result.
 */
@Remote async approve(request: SeatRequestMap['seats/approve']['params']): Promise<SeatRequestMap['seats/approve']['result']>

/** Cancel pending work without closing a window.
 * @param request - queue item and observed version.
 * @returns the committed cancellation result.
 */
@Remote async cancel(request: SeatRequestMap['seats/cancel']['params']): Promise<SeatRequestMap['seats/cancel']['result']>

/** Read committed gate state.
 * @param request - gate filters and cursor.
 * @returns a gate state page.
 */
@Remote async gates(request: SeatRequestMap['seats/gates']['params']): Promise<SeatRequestMap['seats/gates']['result']>

/** Read local node state without activating providers.
 * @param request - empty parameter object.
 * @returns the node alias and capacity.
 */
@Remote async nodeStatus(request: SeatRequestMap['seats/nodeStatus']['params']): Promise<SeatRequestMap['seats/nodeStatus']['result']>
```

Source: [`packages/seat/seat-remote/src/index.ts`](../../packages/seat/seat-remote/src/index.ts)

<a id="ctxseats--seatservice-abstract-seam"></a>

### `ctx.seats` — `SeatService` (abstract seam)

Unified node-local operations; provider derives authority from authenticated context, never wire tags.

```ts cordis-catalog
/** Derive an operation-local facade from verified server-side authority, never raw request fields.
 * @param authority - principal, node and origin already authenticated by the trusted adapter.
 * @returns a scoped facade with no process-global current identity.
 */
abstract withAuthority(authority: T.SeatCallContext): SeatService

/** Report local placement even when the optional engine is absent.
 * @returns node identity and available engine evidence.
 */
nodeStatus?(): Promise<T.SeatNodeStatus>

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

/** Consume an authenticated frozen request locally without resolving its source again.
 * @param request - Complete frozen input bound to this facade's live authority.
 * @returns Original opening outcomes; absence denies the negotiated method.
 */
openFrozen?(request: T.OpenFrozenSeatRequest): Promise<T.OpenFrozenSeatResult>

/** Wake locally, consuming the frozen fallback only when no eligible window exists.
 * @param request - Original wake identity and frozen fallback.
 * @returns Original wake outcomes without another routing hop.
 */
wakeFrozen?(request: T.WakeFrozenSeatRequest): Promise<T.WakeFrozenSeatResult>

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
```

Types: [SessionId](core.md)

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatworktreehost--seatworktreehost"></a>

### `ctx.seatWorktreeHost` — `SeatWorktreeHost`

Durable worktree owner supplies authoritative records and authorization to policy.

```ts cordis-catalog
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
inspect(tree: import('./types.ts').SeatWorktreeRegistration): Promise<{ verified: boolean merged: boolean trackedClean: boolean lastChangedAt: number | null }>

/** Validate the authorization reference against the caller, never model prose.
 * @param request - Registration containing the caller authorization reference.
 * @returns Whether independent authorization permits the request.
 */
authorize(request: import('./types.ts').RegisterSeatWorktreeRequest): Promise<boolean>
```

Source: [`packages/seat/seat/src/gates.ts`](../../packages/seat/seat/src/gates.ts)

<a id="seat-events"></a>

### `seat/*` events

<a id="seatdecision--parallel"></a>

#### `seat/decision` — parallel

Published only after a decision is durable; observer failure cannot undo the commit.

```ts cordis-catalog
/** Published only after a decision is durable; observer failure cannot undo the commit.
 * @mode parallel
 * @param decision - committed frame and its complete effects.
 */
'seat/decision'(decision: EngineDecision): void
```

Source: [`packages/seat/seat/src/events.ts`](../../packages/seat/seat/src/events.ts)

<a id="seatready--parallel"></a>

#### `seat/ready` — parallel

Runtime readiness starts the host-recovery resource-release timing interval.

```ts cordis-catalog
/** Runtime readiness starts the host-recovery resource-release timing interval.
 * @mode parallel
 * @param status - local node state, including the ready timestamp.
 */
'seat/ready'(status: import('./types.ts').SeatNodeStatus): void
```

Source: [`packages/seat/seat/src/events.ts`](../../packages/seat/seat/src/events.ts)
<!-- END GENERATED cordis-surface -->
