---
description: "Service definitions for node-local seats, engine operations, policies, and registered directories."
kind: "package-reference"
---

# @panedesk/dsh-seat

English | [中文](README.zh.md)

## Summary

Defines the seat services and shared request, result, event, and policy types. Importing this package does not install an engine, create Sessions, or register tools. The [seat subsystem](../../../docs/subsystems/seat.md) owns the type reference.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Optional `SeatOpeningContexts.registerScopeAdmission` installs an `OpeningScopeAdmission` owner for source-backed single openings and task batches. The owner serializes evaluation, durable reservation and the existing executor; disposal drains active calls. Omission preserves existing evaluator lookup and refusal behavior. The interface contains no source-specific ticket fields.

Optional opening snapshots and trigger references preserve provider revision and task evidence without changing legacy opening requests. `OpeningContextProvider.callback` optionally receives durable manual outcomes with the frozen reference and original operation identity; callers cannot supply a callback destination. The local provider owns routing and delivery lifecycle. `SeatGateService.evaluateTaskScopes` is an optional preflight capability; task-aware callers must refuse rather than bypass an absent evaluator. Authorization declarations expose host-owned issuer registrations, process-local grants, atomic action transactions, and historical queries. Optional `validate` rechecks live grants before resuming external work without replacing transactional admission. `seatAuthorizedEngineActions` carries grants to renewal and replacement; `seatAuthorizationExports` exposes a separate versioned JSON page rather than widening legacy effects. Importing these definitions installs none of their providers; `seat-engine` supplies persistence and queries.

Providers implement `SeatService`, `SeatEngineService`, `SeatGateService`, and `SeatDirectoryService`. Consumers resolve optional services with `ctx.get`; missing providers do not authorize operations or activate replacements. `withAuthority` accepts authenticated server-side authority, never identity claims copied from a request.

Optional `seatAuthorizationTransactions.operation` returns `SeatEngineOperationResult`: the existing operation result plus approval registration and correlated progress metadata. It reads committed facts without admitting actions; older providers may omit it.

`node-work-chain/v1` declares seven closed methods, frozen source input, explicit remote-opening allowlists, runtime model evidence and a required `node-route/accepted` effect. Optional `openFrozen`, `wakeFrozen`, `acceptFrozen` and source preparation/check/callback hooks require separately installed authenticated providers; omission grants nothing. `SeatFrozenOpen.nodeWorkChain` retains admission for dispatch rechecks, `SeatBinding.staffBinding` carries verified roster evidence, and `SeatCallbackDelivery.nodeWorkChain` freezes the complete remote callback. Missing model evidence remains missing, never inferred from configuration. Original refusals use optional `cause`: code/domain are controlled ASCII identifiers up to 128 bytes and sanitized reason is at most 512 UTF-8 bytes. The complete negotiated frame ceiling is 1,048,576 bytes, reduced by either peer or local limits; oversized input is rejected without truncation. Importing these declarations neither enables routing nor changes old payloads. Durable providers must reject unsupported required effects before applying any part of a frame.

Optional `nodeWorkChainBusiness` registers `NodeWorkChainBusinessProvider` owners for the six business methods, never `chain.operation`. Each method has one provider globally; overlapping or repeated registration throws without partial registration. Resolve it with `ctx.get` and skip registration when absent, preserving the baseline behavior. Queries use the complete business key and payload digest under authenticated context, not transport pending or legacy operation lookup. Each provider's recovery barrier covers all persisted intents and inboxes; before it resolves, queries return only pending/unknown, never missing, and recovery failure forbids capability advertisement. Optional resume reauthorizes the restricted outbox identity, retains the original key and digest, and requires provider-owned atomic deduplication. This package supplies declarations only; the registry and business owners are separate providers.

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
