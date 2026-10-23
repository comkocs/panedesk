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

Catalogs initially belong to their import source. A recorded authority change permits direct catalog edits. Import preview retains source hashes and revisions; commit rechecks them. Live operations require `withAuthority` from a trusted adapter and reject cross-node requests. Directory authorization combines the saved seat paths with the active filesystem and sandbox policy; catalog membership does not bypass sandbox denial.

## Window transactions

Manual opening freezes rendered text and the request in durable ingress. The executor uses the reserved Session identity, binds ledger attribution during creation or resume, configures the window, and sends the opening through durable message delivery. Replacement completion requires the original opening message, a completed containing turn and an assistant reply; a later unrelated reply does not qualify.

Manual renewal uses the engine maintenance path. Close blocks new turns, rechecks evidence, archives the Session, pins the closed title and flushes persistence before recording terminal accounting. A failure before archive releases the barrier; a failure after archive retains it for replay. Rename receipts retain the original result, so replaying an earlier rename cannot overwrite a later title. Ambiguous intermediate title history is rejected rather than reported as success.

Waits retain authorized object identities and terminal observations. Job reads target the owning Session rather than scanning all Sessions. Schedule delivery is complete only after its consuming model turn completes; deletion is cancellation, not completion. The provider drains accepted observation work on unload and reconstructs unfinished waits from engine facts on reload.

## Dev Note

[`index.ts`](src/index.ts) owns plugin activation and disposal. [`service-options.ts`](src/service-options.ts) separates deployment configuration from trusted runtime capabilities; the owning [seat subsystem](../../../docs/subsystems/seat.md) defines the shared service semantics.

## Model Experience

### Opening and wake messages

#### What the model sees

The model receives rendered opening or wake text from the configured seat definition. Templates resolve the seat, date and optional task identifier before admission; replay reuses the retained opening text. Subscription contents are supplied by the installed instruction-subscription provider.

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

- Durable prefill admission is unavailable with engines that do not expose the optional opening transaction. The local ingress rejects it rather than sending an unintended first turn.
- Engines must preserve the frozen definition and title when admitting queued local ingress. The current dispatcher resolves its own definition and title, so delayed admission across catalog revisions needs engine-side reconciliation.
- Engine-internal list and close calls require a trusted authority adapter. A replacement driver that republishes a different terminal close after `recordClosed` can report a terminal-state conflict; subsequent reconciliation reads the committed close.
- Reconfiguring a budget while opening remains pending requires an engine that does not overwrite that revision with the earlier opening snapshot.
- Rename recovery refuses a staged receipt whose title event is absent from the restored Session. It does not infer an outcome or append a speculative replacement event.
