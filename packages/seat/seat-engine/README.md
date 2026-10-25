---
description: "Durable node-local seat admission, recovery, budgets, and callback delivery."
kind: "package-reference"
---

# @panedesk/dsh-seat-engine

English | [中文](README.zh.md)

## Summary

Implements the [seat engine service](../../../docs/subsystems/seat.md) with a separate journal, durable queues, resource ownership, and callback outbox. Installation is explicit; ordinary profiles do not enable automatic opening.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

External rules match `sourceId` exactly and, when present, `eventType` exactly. A configured external rule set with no match cannot fall back to project auto mode; profiles without external rules retain their existing behavior. When external rules are configured, coalescing separates external sources and event types; opening references always remain separate. Optional context references require a registered source and compatible local freezer; accepted snapshots retain text, digest, revision and task associations in the existing decision transaction before acknowledgement. Source cursors remain adapter-owned and must advance only after durable acceptance.

Mount the plugin with a complete `Config` and a `sessionLedger` provider. The ledger supplies node identity; `home` selects isolated storage. Validate positive byte, batch, deduplication, callback, and recovery limits before activation. The owner-observation interval is at most one second; observation, release, and queue-wakeup budgets together must not exceed five seconds. Missing budget or node capacity limits mean unlimited, not an invented quota.

Storage layout: the node journal keeps `owner.lock` beside `events/`. Linux and macOS retain the existing descriptor flock and immediate contention failure. Only win32 uses exclusive-share opening of this dedicated lock file, with a 100 ms retry budget and 10–40 ms backoff. Lock contents are never read or written; close or process exit releases ownership, and the file must not be removed or replaced. Startup failure diagnostics include error codes, not paths or journal contents.

Project policy defaults to `remind` with `modeChosen: false`. Each entry into approval commits one `queue/reminded` event with the pending item; coalescing, redelivery and replay do not repeat that reminder. Approval removes only reminder confirmation; capacity, time windows, exclusive resources, and budget checks still apply. Incomplete cost evidence blocks admission rather than counting as zero. The local executor owns Session effects; the engine retains original intent identities through recovery and never blindly retries uncertain model requests.

Accepted openings retain their definition, title and rendered text through queueing and recovery; current project and rule mode restrictions still apply. Manual prefill configures the original Session without sending a model request. Opening progress cannot roll back a committed budget revision. Local providers register engine-only list and close capabilities without relaxing external authority checks. Close barriers retain their operation identity, and conflicting replacement terminal summaries fail with `state-conflict` before append.

The Loader installs `subagentAdmission`, `subagentNotifications`, and `jobNotifications`. Seat-bound parents use their definition's child capacity and child-specific cache/context evidence. Completion records live under the node journal's `notifications` directory; job intent writes are synchronous before producer effects, and pending handoff/steer sends reuse stable message operations. Unsettled recovered jobs report unknown owner loss, never replay external work.

Explicit `sources` configure schedule records, registered Git paths/refs, window-ended observations, and unanswered handoff deadlines. Before enabling the `seat.open` handler, startup reconciles persisted actions with configured sources: changed records are deleted and recreated, unchanged records retain their next occurrence, and actions whose payload names a removed source are deleted even when `sources` is empty. Comparison uses normalized record fields and accounts for recurrence advancement after the last receipt. Other action names are untouched. Replacement and removal log `Seat schedule source reconciled` and `Seat schedule source removed`; failures warn through `Seat schedule registration failed` without blocking the host, leaving the handler unavailable until a successful restart. Replacement is not atomic; failure after deletion leaves the action absent until the next reconciliation. Git only reads registered repositories. Manual ingress remains with the local provider and signed external ingress with the remote provider. Source callbacks for these observers are local acknowledgements, not outbound HTTP callbacks.

Local execution policies can require a durable `recheckRequired` marker at acceptance and revalidate the original queue input before dispatch and unfinished opening recovery. A confirmed no-effect refusal cancels the queue and requires fresh preflight; unknown or unavailable permission retains occupancy. Queue changes during an asynchronous check invalidate that check. Missing required policies never grant permission. These checks do not make external source reads atomic with Session creation.

A local provider may register `preAdmit` with its engine access. Manual `openWindow`, including each opening dispatched by a local batch, awaits this hook before trigger acceptance. A refusal is returned unchanged without engine acceptance, resource or Session effects; policy audit belongs to the hook provider. Without the hook, the original admission path is unchanged.

Trusted hosts register captured identities and live policy checks through `seatAuthorizationIssuers`; callers receive instance-owned grants, not authority derived from request fields. `seatAuthorizationTransactions.transact` commits authorization and matching intent in one synchronized journal frame. Every submitted effect must carry the issued operation identity. `approve` commits the queue transition in that same frame rather than calling the legacy approval method; a denied approval keeps its original refusal on retry, so a newly authorized attempt needs a new operation identity. Revoked, foreign, stale, and mismatched grants are refused. A failed append admits no projected action; an uncertain synchronization outcome requires recovery before retry.

Authorization frames require `seat-authorization/v1`; older decoders refuse the new discriminator. Capability-aware recovery and read-only snapshots retain facts in the existing journal. New queries include `plugin`; legacy `seatAuthorizationQueries.query` skips that kind while advancing the physical cursor, never relabeling it. Queries filter by task, seat, node, kind, and time, and return the committed watermark, exclusive scan cursor, and completeness. Historical decisions without attribution remain `legacy-unknown`. Engine-effect queries and exports retain their legacy vocabulary and omit authorization facts. The independent `seatAuthorizationExports.export` service serializes a bounded `seat-authorization/v1` JSON page with its cursor, watermark and completeness, including plugin attribution; both the live engine and offline reader provide it.

Remote admission frames require `node-work-chain/v1` and a `node-route/accepted` fact beside matching issued authorization and frozen trigger intent. Replay validates the complete source identity, owner epoch, snapshot, scope reservation and original operation; a second admission for that business identity is refused before append. Legacy decoders reject the complete frame. Retained chain input separates coalescing identities and restricts every dispatch by the source mode ceiling, including after recovery. An injected routed callback sender receives the frozen owner route; only a matching committed receipt completes delivery. Missing senders and pending receipts retain retries without falling back to a same-named local source; authentication and protocol failures pause delivery. `acceptFrozen` verifies the locally issued sending-node fact and target allowlists, then commits the complete business key with authorization and frozen intent. Exact retries return the first acknowledgement before new-admission checks, even after target definitions or live issuers disappear; changed payloads conflict. Complete-process recovery rebuilds this acknowledgement from committed frames; an interrupted frame admits no partial intent. Optional `nodeWorkChainBusiness` registration waits for journal and seat admission recovery and serves exact-key queries; before recovery it reports unknown. Withdrawal rejects captured queries and frozen or batch writes, draining admitted calls before resource release; replacement cannot inherit readiness. Business registration requires both the registry and explicit `nodeWorkChain` services. Either missing dependency leaves the engine with no chain registration or chain storage and preserves ordinary replies. Frozen dispatch requires a registered permission recheck; missing execution policy retains the queue. Production source proxies and outbound authorization assembly remain separate.

Node batches retain independent member decisions. Each `node-batch/accepted` fact requires `node-work-chain/v1` and binds the original batch payload and issued authorization to one deterministic member action in the same frame. Recovery rejects mismatched bindings and returns the first queued acknowledgement; interrupted later members do not roll back committed earlier members. No new local grant is issued.

Routed callbacks freeze execution-node model evidence before their first durable publication. The registered local executor supplies a recorded model or explicit missing evidence; missing evidence never falls back to seat configuration. Replays retain the original evidence and digest, including missing observations. Journal admission rejects inconsistent callback digests, execution identities and attempts to replace already frozen evidence.

`seatAuthorizationTransactions.operation` rebuilds approval registration and correlated opening progress from the committed queue and trigger facts. Pending reasons, created phases, cancellations and recorded failures remain queryable after restart without executing work or exposing frozen instructions. Approval does not imply creation or first-turn success.

Authorized `cancel` commits `queue/cancelled` with its issued authorization, principal, kind, operation ID, queue ID, timestamp, revision and optional reason. Reasons contain at most 512 UTF-8 bytes and no control characters. Operation lookup returns the settled cancellation receipt; redacted effects retain only reason presence. Queue and operation indexes retain the latest 256 receipts each, with older lookups reconstructed from committed decisions. Pending and approved-but-undispatched items have no budget or resource reservation: cancellation neither creates nor changes those projections. Dispatched, opened and unknown targets retain `revision-conflict` with a structured `cause.reasonCode`; unaudited cancellation retains its original bytes and attribution. Cancellation does not release external scope reservations.

Directory synchronization tolerates only `EPERM`, `EISDIR` and `EINVAL` from opening or flushing directory handles on Windows. File writes, file synchronization, directory close failures and every non-Windows failure still propagate; Windows does not gain a guarantee that unsupported directory metadata synchronization completed.

Committed decisions update projections and outbox delivery. Source callbacks are at-least-once with stable identities; credentials are supplied by source registrations rather than stored in engine records. Disposal stops ingress, drains owned work, flushes the journal, and releases writer ownership.

<a id="model-experience"></a>
## Model Experience

### Executor-owned work

#### What the model sees

The `seatEngine` provider contributes no tool schema or prompt. Registered executors deliver opening and budget notices through the existing message services.

#### Token effect

Admission and queries use no model tokens. Admitted work and cache maintenance can issue model requests through their respective providers; accounting includes descendants and maintenance.

#### KV Cache effect

Queries and journal commits preserve existing request prefixes. Cache maintenance is an independent provider request; unknown renewal outcomes are retained rather than replayed automatically.

## Known Limitations and Deferred Work

- `seatAuthorizedEngineActions` commits renewal attempts and replacement queues with issued grants, preserving legacy methods when no grant is supplied. Current authority is rechecked before admission; historical receipts cannot dispatch another action. Issuer registration alone does not wire CLI or all automatic ingress; those consumers still need explicit adapters.
- Opening and recovery require a registered local executor; absent evidence leaves work pending instead of fabricating a window.
- The active provider owns a writer and reconciliation timer; it is not an offline read-only query provider.
- Account concurrency statistics are diagnostic, not an enforced account limiter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Preserve incomplete journal tails and reject middle corruption before accepting writes. Writer ownership and committed sequence comparisons belong to the journal.

</details>
