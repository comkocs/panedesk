---
description: "Owner-authorized read-only subagent parent-child tree with per-node monitoring for the dsh web client."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-subagent-tree

English | [中文](README.zh.md)

## Summary

Open a session's subagent tree from its header into a right-sidebar tab. Nested rows show state, model, token totals and cache hit rate. Each Monitor button opens read-only status (running, waiting or end reason), model, five token columns, cache hit rate, elapsed time, latest tool invocation and time, seat and linked task. The view offers no writes; stopping retains existing session controls. Model names come only from session transcripts; missing names stay unknown, never backfilled from the ledger.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The compact 28px pill preserves the existing header height and appears only inside an open session's header actions band, after the subagent catalog pill; it contributes no first-screen or guide-page entry. Picking it opens this session's tree page in the right Sidebar as the `subagenttree` tab kind, addressed `dsh-resource://subagenttree/session/<sessionId>`. The tab polls the `subagentTree.read` Remote at the deployment's refresh cadence and renders the eight states (idle, loading, empty, error, unauthorized, disabled, success, failed) with bilingual copy. A node row indents by tree depth, prefixes its state dot, and shows the label from the session projection (falling back to the session id). Monitoring facts state each value or its explicit unknown; usage evidence coverage (`missing` / `partial` / `complete`) is shown rather than zero-filled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host half exposes exactly one Remote, `subagentTree.read(request)`, after checking the invocation principal is an authenticated owner. The tree reads a deduplicated `sessionLedger` snapshot directly (it does not modify `ledger-query`): membership follows `parentSessionId` chains that reach the requested session, cycles degrade to exclusion, and ledger row order is the observation order. Per-session token columns sum call finishes with usage; short-tier writes exist only when a call proves tiered cache writes, untiered writes keep only their total, and cache hit rate is cache-read over uncached input plus cache-read plus observed writes with a zero denominator unknown. Status is `finished` with the ledger end reason when a latest run residency has a finish, else `waiting` while an unpaired `wait/start` has no `wait/end`, else `running`; liveness comes from process observations. The model id and latest tool invocation fold the session's own log suffix through `sessionQuery.readSession`, skipping the fork-inherited prefix; a missing `sessionQuery` marks the model unavailable and an unreadable log marks it unreadable — both stay unknown on the wire.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Read-only session tree

#### What the model sees

Nothing. `subagentTree.read(request)` reads the ledger and transcripts for client UI; it sends no prompt section and calls no model-facing tool.

#### Token effect

None. Reads add zero model tokens.

#### KV Cache effect

None. Reads never edit request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Transcript reads are serial and unbounded** — each read polls every tree node's own log suffix through `sessionQuery.readSession` in ledger order; a wide tree lengthens one read and no per-node bound is imposed yet.
- **Waiting is wait-pair counting** — `waiting` compares unpaired `wait/start` and `wait/end` auxiliary facts; a provider that never pairs waits shows `running`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
