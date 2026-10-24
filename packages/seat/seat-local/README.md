---
description: "Node-local seat catalogs, controlled Session creation and recoverable window operations."
kind: "package-reference"
---

# @panedesk/dsh-seat-local

English | [中文](README.zh.md)

## Summary

The opt-in provider implements the [seat services](../seat/src/index.ts) with private catalog storage, authenticated operation scopes and the installed seat engine. It does not launch a client or select a node implicitly. Missing engine or runtime evidence produces an explicit unavailable result rather than an empty-window or idle claim.

## Table of Contents

- [Configuration and ownership](#configuration-and-ownership)
- [Window transactions](#window-transactions)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration and ownership

The function plugin exports `apply`, `inject` and its configuration type. Supply `LocalSeatOptions`: the catalog directory, node identity and aliases, resolved definition defaults, positive input and transaction limits, and the closed-title suffix. `storageDomain` is required; the engine and Session capabilities attach through optional service lookup. Controlled opening requires public Session creation, Agents, ledger, title, permission and subscription providers.

Catalogs initially belong to their import source. A recorded authority change permits direct catalog edits. Import previews persist in the version-1 `seat_import_plans` single-document domain under the catalog writer lease without changing catalog revision; commit rechecks source hashes and revision across processes. Plans expire after 24 hours unless `importPlanTtlMs` is configured; expired plans return `import-preview-stale`, and the next preview reclaims their capacity within `maxPlans`. Catalog paths accept POSIX absolute paths and fully qualified Windows drive or UNC paths on any host; directory comparison uses each path's own syntax and ignores Windows case. Live operations reject foreign nodes first, then reject incompatible executable paths with `invalid-definition` and an instruction to edit the definition; import-source metadata is not an executable path. Foreign-style roots do not own local directories, and incompatible definitions expose no usable directory roots. Live operations require `withAuthority` from a trusted adapter and reject cross-node requests. Directory authorization combines the saved seat paths with the active filesystem and sandbox policy; catalog membership does not bypass sandbox denial.

## Window transactions

Model tool opening captures the live Session and invocation identifiers, signs `model-tool-call` attribution through the optional engine issuer, and commits it with trigger acceptance. Request fields cannot select the authorization kind. Without the issuer, existing opening behavior is unchanged.

`seatOpeningContexts` accepts trusted in-process providers. Manual and registered engine ingress freeze the same revisioned text without template expansion; accepted retries reuse the retained snapshot even after provider removal. References do not grant authority. Registration disposal rejects new resolutions and drains active ones. Task-aware batches require an installed scope evaluator and complete evidence before any member opens; refusal offers serial execution. Existing requests without these additions retain their original path.

Traditional creation checks directory ownership before the factory runs. Mismatched or ambiguous ownership returns candidates and opening commands without selecting a seat. Trusted adapters consume one-use traditional confirmations through `seatLocalCreation.confirmTraditional/run`. Free identity is stored beside Session data in the engine journal, not in Session headers or the seat roster. Parent identity comes from durable opening or binding facts. Free creation registers failure cleanup, so even an unconfirmed factory failure releases temporary ledger attribution before returning. Resume checks admission before residency accounting: durable seat bindings supply attribution, while free or unbound resumes retain the loop's launch-label resolution. Temporary resume bindings are released after factory settlement; the loop owns successful residency attribution. Neither path changes Session headers.

Local single opening invokes optional `before-open` before initial admission; batches invoke `before-batch-open` before their first seat. Direct engine openings use the same policy through registered `preAdmit`, before acceptance or Session effects; a refusal records only the existing policy audit once. Accepted operations replay frozen inputs. Manual renewal checks runtime work as well as cache evidence. Window lists display six runtime states independently from engine budget stop and closing, both of which prevent renewal.

Policy hosts persist worktree registrations and operation identities through the existing storage facility and verify repositories and branches with read-only Git queries. `repositoryId` is the canonical Git common directory. Reminders use existing durable steer delivery; acceptance does not imply model completion. Close reminders persist their original text and operation identity before serialized delivery. Recovery reuses both for durable delivery deduplication and does not resend records marked sent. The version-1 `seat_close_reminders` storage domain uses `per-record` layout: its `reminders` table is keyed by the operation identity digest and stores string fields `sessionId`, `operationId`, `text`, and boolean `sent`. These records are separate from Session history.

Manual opening freezes the definition, date title, rendered text and request in durable ingress. Window titles and the template variable `date` use the local calendar date in the node's configured time zone, defaulting to UTC; `date` retains the `YYYY-MM-DD` format. Prefill returns the frozen draft after configuration without sending input or starting a turn. The provider privately registers trusted engine list and close capabilities; the public unscoped service still rejects calls without authority. The executor uses the reserved Session identity, binds ledger attribution during creation or resume, configures the window, and sends the opening through durable message delivery. Replacement completion requires the original opening message, a completed containing turn and an assistant reply; a later unrelated reply does not qualify.

Authenticated `operation` reads the optional engine operation projection first, including approval registration and correlated opening progress. Missing capabilities or missing operation facts retain the existing local effect lookup; querying never starts an engine or executes an action.

Manual renewal uses the engine maintenance path. Close blocks new turns, rechecks evidence, archives the Session, pins the closed title and flushes persistence before recording terminal accounting. A failure before archive releases the barrier; a failure after archive retains it for replay. Rename receipts retain the original result, so replaying an earlier rename cannot overwrite a later title. Ambiguous intermediate title history is rejected rather than reported as success.

Waits retain authorized object identities and terminal observations. Job reads target the owning Session rather than scanning all Sessions. Schedule delivery is complete only after its consuming model turn completes; deletion is cancellation, not completion. The provider drains accepted observation work on unload and reconstructs unfinished waits from engine facts on reload.

Controlled creation and resume optionally obtain session-bound credentials from `hostSessionCredentials` before publishing the agent. The shell environment registry contributes only `DSH_HOST_ENDPOINT_PATH` and `DSH_HOST_CREDENTIAL_PATH` for the calling session, never credential bytes. Archive, replacement, and agent disposal revoke the old binding. Without the administration issuer, creation remains unchanged. The current persistent seat binding has no employee field, so this provider issues seat-only identities and never guesses an employee ID.

## Dev Note

[`index.ts`](src/index.ts) owns plugin activation and disposal. [`service-options.ts`](src/service-options.ts) separates deployment configuration from trusted runtime capabilities; the owning [seat subsystem](../../../docs/subsystems/seat.md) defines the shared service semantics.

## Model Experience

### Opening and wake messages

#### What the model sees

The model receives rendered opening or wake text from the configured seat definition. Templates resolve the seat, date and optional task identifier before admission; replay reuses the retained opening text. Window titles and the template variable `date` use the local calendar date in the node's configured time zone, defaulting to UTC. Subscription contents are supplied by the installed instruction-subscription provider.

#### Token effect

Rendered text and subscribed instructions consume input tokens when included in a model request. Catalog reads, resource reservations and operation receipts do not themselves call a model.

#### KV Cache effect

Opening creates a new Session history. Waking appends input to the existing history. Subscription changes follow the subscription provider's request-prefix behavior; this provider does not rewrite prior model-visible messages.

### Context, budget and wait reminders

#### What the model sees

Window context reminders say `Context threshold reached. Consider replacing this window after reporting its pending work.` Child context reminders say `The child context reached its limit. Prepare a handoff summary for a new subagent.` Both use steer delivery. Budget reminders carry the engine's budget snapshot; wait messages identify each object and its observed outcome.

#### Token effect

Reminders consume input tokens on their next admitted turn. Context estimates use the latest completed conversation call's input, cache-read and cache-write token counts; missing evidence is unknown. A successful persisted compaction starts another reminder epoch only after a later ordinary call supplies usage.

#### KV Cache effect

Reminders append input without cancelling the current step or replacing prior history. Stable operation identities suppress repeat delivery within the same definition revision and compaction epoch. Compaction itself is owned by the installed compaction provider.

## Known Limitations and Deferred Work

- Renewal, replacement and close carry issued grants into their original journal admission. Live model invocations issue `model-tool-call` grants for these actions, and engine-owned close issues `engine` grants. Close revalidates authority before archive; audited retries of existing barriers require local reconciliation rather than replaying external work. Legacy calls without grants retain their prior path.
- The provider installs `nodeAuthorizedLocalAdmission` for opening, renewal, replacement and close. Audited rename and wake remain unavailable; batches cannot split one grant across member operations. Extended opening contexts and task-aware batches still lack remote wire evidence. CLI authority remains unwired.
- Worktree maturity requires an explicit upstream, verified merge ancestry, and commit, Git metadata and tracked-file activity timestamps. Missing evidence or a changed HEAD, upstream or tracked working tree prevents a maturity claim. Forced registration still requires independent authorization.
- Durable prefill admission is unavailable with engines that do not expose the optional opening transaction. The local ingress rejects it rather than sending an unintended first turn.
- Rename recovery refuses a staged receipt whose title event is absent from the restored Session. It does not infer an outcome or append a speculative replacement event.
