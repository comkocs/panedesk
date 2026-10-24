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

Project policy defaults to `remind` with `modeChosen: false`. Each entry into approval commits one `queue/reminded` event with the pending item; coalescing, redelivery and replay do not repeat that reminder. Approval removes only reminder confirmation; capacity, time windows, exclusive resources, and budget checks still apply. Incomplete cost evidence blocks admission rather than counting as zero. The local executor owns Session effects; the engine retains original intent identities through recovery and never blindly retries uncertain model requests.

Accepted openings retain their definition, title and rendered text through queueing and recovery; current project and rule mode restrictions still apply. Manual prefill configures the original Session without sending a model request. Opening progress cannot roll back a committed budget revision. Local providers register engine-only list and close capabilities without relaxing external authority checks. Close barriers retain their operation identity, and conflicting replacement terminal summaries fail with `state-conflict` before append.

The Loader installs `subagentAdmission`, `subagentNotifications`, and `jobNotifications`. Seat-bound parents use their definition's child capacity and child-specific cache/context evidence. Completion records live under the node journal's `notifications` directory; job intent writes are synchronous before producer effects, and pending handoff/steer sends reuse stable message operations. Unsettled recovered jobs report unknown owner loss, never replay external work.

Explicit `sources` configure schedule records, registered Git paths/refs, window-ended observations, and unanswered handoff deadlines. Before enabling the `seat.open` handler, startup reconciles persisted actions with configured sources: changed records are deleted and recreated, unchanged records retain their next occurrence, and actions whose payload names a removed source are deleted even when `sources` is empty. Comparison uses normalized record fields and accounts for recurrence advancement after the last receipt. Other action names are untouched. Replacement and removal log `Seat schedule source reconciled` and `Seat schedule source removed`; failures warn through `Seat schedule registration failed` without blocking the host, leaving the handler unavailable until a successful restart. Replacement is not atomic; failure after deletion leaves the action absent until the next reconciliation. Git only reads registered repositories. Manual ingress remains with the local provider and signed external ingress with the remote provider. Source callbacks for these observers are local acknowledgements, not outbound HTTP callbacks.

A local provider may register `preAdmit` with its engine access. Manual `openWindow`, including each opening dispatched by a local batch, awaits this hook before trigger acceptance. A refusal is returned unchanged without engine acceptance, resource or Session effects; policy audit belongs to the hook provider. Without the hook, the original admission path is unchanged.

Trusted hosts register captured identities and live policy checks through `seatAuthorizationIssuers`; callers receive instance-owned grants, not authority derived from request fields. `seatAuthorizationTransactions.transact` commits authorization and matching intent in one synchronized journal frame. Every submitted effect must carry the issued operation identity. `approve` commits the queue transition in that same frame rather than calling the legacy approval method; a denied approval keeps its original refusal on retry, so a newly authorized attempt needs a new operation identity. Revoked, foreign, stale, and mismatched grants are refused. A failed append admits no projected action; an uncertain synchronization outcome requires recovery before retry.

Authorization frames require `seat-authorization/v1`; older decoders refuse the new discriminator. Capability-aware recovery and read-only snapshots retain facts in the existing journal. New queries include `plugin`; legacy `seatAuthorizationQueries.query` skips that kind while advancing the physical cursor, never relabeling it. Queries filter by task, seat, node, kind, and time, and return the committed watermark, exclusive scan cursor, and completeness. Historical decisions without attribution remain `legacy-unknown`. Engine-effect queries and exports retain their legacy vocabulary and omit authorization facts. The independent `seatAuthorizationExports.export` service serializes a bounded `seat-authorization/v1` JSON page with its cursor, watermark and completeness, including plugin attribution; both the live engine and offline reader provide it.

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
