---
description: "Service definitions for node-local seats, engine operations, policies, and registered directories."
kind: "package-reference"
---

# @panedesk/dsh-seat

English | [中文](README.zh.md)

## Summary

Defines the seat services and shared request, result, event, and policy types. Importing this package does not install an engine, create Sessions, or register tools. The [seat subsystem](../../../docs/subsystems/seat.md) owns the type reference.

Optional `SeatService.messageWindows` and the corresponding `SeatLocalReadAccess` capability expose committed local window identities and primary selection for message routing. Missing capability is not evidence that no seats are open. Queries neither open windows nor modify engine facts.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Browser consumers import shared seat data through the type-only `@panedesk/dsh-seat/types` subpath. Its Session identities use `dsh-session/types` and schedule selectors use `dsh-schedule/client`, keeping shared declarations independent of Host Session services. The root entry continues to expose Host service definitions.

`SeatFailure.details` optionally identifies either a preset refused before Session creation through `agentPreset`, or an unavailable model through `provider` and `model`. `SeatNodeStatus.openingFailures` projects unresolved prerequisite failures separately from Session windows; model failures carry optional `provider` and `model` fields, while runtime engine failures remain in `failure`. Its optional `unavailableOverTenMinutes: true` marks a continuous unavailable interval exceeding ten minutes and disappears with the failure after recovery. Optional `stage: 'turn'` identifies an active-window `UNKNOWN_MODEL` or `session/model-unavailable` diagnostic without changing opening state. Optional `SeatNodeStatus.callbackFailures` lists no-effect issuer or callback-authentication refusals parked for operator resolution, independently of the engine failure. The payload-free `seat/diagnostics-changed` event invalidates authorized reads without disclosing diagnostic fields. [Seat engine](../seat-engine/README.md) owns projection and clearance semantics.

`EngineCloseData` and `window-ended` callbacks optionally retain detail `approval-pending-cancelled`, `restart-manual-opening-closed` or `restart-source-wake-closed` with the existing `manual` end reason. The two restart details also appear in `SeatNodeStatus.openingFailures` after committed closure, preserving a localized warning without authorizing another opening. Missing detail preserves ordinary closure semantics; the [local provider](../seat-local/README.md) owns cancellation and idle rechecking.

Optional `SeatOpeningContexts.registerScopeAdmission` installs an `OpeningScopeAdmission` owner for source-backed single openings and task batches. The owner serializes evaluation, durable reservation and the existing executor; disposal drains active calls. Omission preserves existing evaluator lookup and refusal behavior. The interface contains no source-specific ticket fields.

Optional opening snapshots and trigger references preserve provider revision and task evidence without changing legacy opening requests. `OpeningContextProvider.callback` optionally receives durable manual outcomes with the frozen reference and original operation identity; callers cannot supply a callback destination. The local provider owns routing and delivery lifecycle. `SeatGateService.evaluateTaskScopes` is an optional preflight capability; task-aware callers must refuse rather than bypass an absent evaluator. Authorization declarations expose host-owned issuer registrations, process-local grants, atomic action transactions, and historical queries. Optional `validate` rechecks live grants before resuming external work without replacing transactional admission. `seatAuthorizedEngineActions` carries grants to renewal and replacement; `seatAuthorizationExports` exposes a separate versioned JSON page rather than widening legacy effects. Importing these definitions installs none of their providers; `seat-engine` supplies persistence and queries.

`SeatCheckpointFile.mode` optionally selects `section` (the default) or `file`. Whole-file mode ignores the retained required `section` field and preserves the entire UTF-8 text, subject to `maxBytes`, shared checkpoint budgets and `required`; the [gate provider](../seat-gates/README.md) owns admission and validation.

Providers implement `SeatService`, `SeatEngineService`, `SeatGateService`, and `SeatDirectoryService`. Consumers resolve optional services with `ctx.get`; missing providers do not authorize operations or activate replacements. `withAuthority` accepts authenticated server-side authority, never identity claims copied from a request.

Pending queue metadata optionally includes `windowName`, `nodeId` and `budget` from retained opening evidence. Missing fields remain absent; node aliases are not authenticated node identifiers, and budget strings use integer micro-USD. Older consumers can ignore these fields.

Optional `seatAuthorizationTransactions.operation` returns `SeatEngineOperationResult`: the existing operation result plus approval registration and correlated progress metadata. It reads committed facts without admitting actions; older providers may omit it.

`node-work-chain/v1` declares seven legacy methods plus the independently negotiated `seat.definitionRevision` read, frozen source input, explicit remote-opening allowlists, runtime model evidence and a required `node-route/accepted` effect. Optional `openFrozen`, `wakeFrozen`, `acceptFrozen` and source preparation/check/callback hooks require separately installed authenticated providers; omission grants nothing. `SeatFrozenOpen.nodeWorkChain` retains admission for dispatch rechecks, `SeatBinding.staffBinding` carries verified roster evidence, and `SeatCallbackDelivery.nodeWorkChain` freezes the complete remote callback. Missing model evidence remains missing, never inferred from configuration. Original refusals use optional `cause`: code/domain are controlled ASCII identifiers up to 128 bytes and sanitized reason is at most 512 UTF-8 bytes. The complete negotiated frame ceiling is 1,048,576 bytes, reduced by either peer or local limits; oversized input is rejected without truncation. Importing these declarations neither enables routing nor changes old payloads. Durable providers must reject unsupported required effects before applying any part of a frame.

`SeatDefinitionRevisionRequest` requires exactly `seat`, `sourceId`, `sourceOwnerNodeId`, `ownerEpoch`, `openingMethod` and `taskIds`. Its result is `SeatRejected` or `{ status: 'found', nodeId, seat, revision }`, with a positive safe-integer per-definition revision. Optional `seatDefinitionRevisions` supplies `ready`, `available` and independently authorized `read`; importing it grants no read or execution permission. The observation is neither a business method nor a `chain.operation` target and cannot replace a persisted frozen revision.

Optional `nodeWorkChainBusiness` registers `NodeWorkChainBusinessProvider` owners for the six business methods, never `chain.operation`. Each method has one provider globally; overlapping or repeated registration throws without partial registration. Resolve it with `ctx.get` and skip registration when absent, preserving the baseline behavior. Queries use the complete business key and payload digest under authenticated context, not transport pending or legacy operation lookup. Each provider's recovery barrier covers all persisted intents and inboxes; before it resolves, queries return only pending/unknown, never missing, and recovery failure forbids capability advertisement. Optional resume reauthorizes the restricted outbox identity, retains the original key and digest, and requires provider-owned atomic deduplication. This package supplies declarations only; the registry and business owners are separate providers.

Optional `SeatAuthorizationFact.sourceNodeId` appears only on locally issued `node-delegation` facts: the receiving policy captures the transport-authenticated sending node in the issuer entry identity, never from request JSON. Legacy facts and delegations remain byte-for-byte unchanged. Optional `SeatOpeningContexts.registerSourceOwner` installs one trusted `SeatSourceOwner` with required `prepare`, `checkAdmission` and `deliverCallback` methods matching the existing optional hooks. Repeated registration throws; disposal stops new calls and drains in-flight calls. Without a registered owner, providers do not expose these three methods; this package installs no implementation.

Host-only `SeatCallContext.localWake` carries the separate exact opening grant for a local owner wake; `authorization` carries the original wake grant. Both are process-local issuer-owned capabilities, not JSON authority. The local provider requires both and never selects legacy admission when either is missing. No authorization kind or wire method is added.

Optional `seatLocalCallbackOwner: SeatLocalCallbackOwner` supplies `ready`, `available`, exact-key `query` and frozen-body `deliver` for callbacks whose source owner, target and execution node are the local engine. Each query or delivery returns `SeatCallbackAttemptResult<R>` with an optional `SeatCallbackDiagnostic`; the provider owns independent authorization, durable deduplication, recovery and withdrawal. Importing declarations installs no provider or default injection, and absence never permits source or peer fallback. `SeatCallbackDelivery.lastDiagnostic` is an optional outer delivery observation, never part of the callback body or business digest; older records omit it and successful delivery clears only the latest observation. Failure stages are `retained`, `issuer`, `local-query`, `local-dispatch`, `peer-query`, `peer-dispatch`, `owner-inbox` and `writeback`; causes retain bounded identifiers and sanitized reasons.

Optional callback `retrySummary` records folded failures, timestamps, safe detail and continuous transient timing; recovered retry counts are lower bounds. `ownerPending` excludes owner progress from transport timing, and `parkingClass` distinguishes owner confirmation from transport failure without changing legacy codes. Pending callback and exact-operation receipts may carry a fixed `pendingReason` (`owner-recovering`, `writeback-pending`, `writeback-outcome-unknown`, `desk-unreachable`); it contains no endpoint or credentials. All additions are optional for legacy records; paired providers own recovery and upgrade restrictions.

Optional `OpenSeatRequest.startupDirectory` selects an exact registered directory for a manual opening. Omission preserves the profile startup directory. The local provider freezes the selected startup flag for execution and replay without editing the catalog or broadening directory authorization; retries must preserve the same selection.

Optional `SeatEngineService.wakeSource` accepts a registered external event with task context; absence or an undefined result preserves ordinary trigger ingress. Optional `SeatEngineConfig.sourceWake` selects source/event pairs, and `frozenWakeContext` enables frozen task text in existing-window delivery. Both are disabled when omitted; [seat-engine](../seat-engine/README.md) owns validation, authorization and durable outcomes. No wire method or existing required field changes.

Stable operation identities, revision comparisons, explicit incomplete pages, and typed refusals preserve observable outcomes across retries. Engine decisions live outside the Session event union. Configuration and execution belong to providers; the declarations supply no deployment defaults.

<a id="model-experience"></a>
## Model Experience

### Service declarations

#### What the model sees

`SeatService` and the other declarations contribute no tools, prompt text, or messages.

#### Token effect

Importing the definitions adds no request tokens and starts no model requests.

#### KV Cache effect

The package does not change request prefixes or refresh provider caches.

## Known Limitations and Deferred Work

- Services require separately installed providers; declarations alone cannot open, renew, close, or query a window.
- Live operations are node-local. A node identifier is not permission to execute on another node.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Providers own durable commits and awaited disposal; consumers must not infer success from missing evidence.

</details>
