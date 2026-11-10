---
description: "Read-only ledger query and export service definitions."
kind: "package-reference"
---

# @panedesk/dsh-ledger-query

English | [中文](README.zh.md)

## Summary

Read-only ledger selection, coverage-aware statistics and safe exports over the optional session ledger. The concrete Cordis service never launches a model or reads conversation transcripts.

JSONL round trips retain activity start/end auxiliary rows, including task identities, timing and confirmed created-file paths. These rows do not add model calls or token usage.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Call queries and exports consume the ledger provider's incrementally maintained snapshot; descendant selection builds one parent-child index, and liveness selection indexes observations once per read. Merge comparison serializes facts only for repeated row identities; unique rows still receive the same wait projection and stable ordering. Integrity rejection, stable ordering, watermarks and export encodings remain unchanged.

Import the Host service from the package entry and wire-safe statistics types from `/types`. `ledgerQuery.stats(request, asOf?)` reads one deduplicated public snapshot for overview, history, model usage, throughput and call details. Ranges are `today`, `6h`, `24h`, `72h`, `168h` and `all`; `today` starts at Beijing midnight, with half-open start-time ownership. Hour/day buckets align to Beijing time. Grouping supports seat, task, model, window, root/child and agent definition; optional seat/task/model filters apply to attribution. The package has no browser runtime entry.

Reference USD sums use decimal strings; missing price, usage, timing, wait or fingerprint evidence remains unknown. Throughput is output tokens divided by ledger model-in-flight seconds, not wall time. Cache hit rate excludes keepalive, whose usage and reference cost remain separate. Running lanes count unique unfinished child sessions, not root windows or process-liveness observations; unresolved remote aliases make the count unknown. Projects use seats because the ledger contains no workspace directory. The [statistics UI](../../client/ui-stats/README.md) owns the authenticated owner-only Remote read and presentation.

Optional `details: { limit, after? }` pages call details without limiting totals. The exclusive cursor orders by ascending `startedAt`, `nodeId`, then `callId`, with code-unit string ordering; it retains the first page's `asOf`. Omit `details` for the complete detail set. Keep filters unchanged while continuing; `nextDetailCursor: null` ends pagination, including an empty page. Historical queries rebuild wait summaries only from facts observed before `asOf`. A completed newer residency supersedes older unfinished residencies of the same session; a later reopened residency remains unfinished. Reads rescan the available ledger, so late backfill or incomplete scans are not an immutable snapshot guarantee.

`panedesk --profile ledger engine` dispatches `events`, `gates`, `pending`, `export`, and `verify` through optional seat providers. Events retain exclusive cursors, completeness and committed watermarks; engine records remain separate from accounting and message journals. Export requires an explicit JSONL output path; verification never executes imported operations. Missing providers do not change existing accounting or message commands.

`panedesk --profile ledger messages --help` lists strict message commands. Delivery commands use the optional `messageDelivery` service; message queries use the optional ledger `queryMessages` and `querySessions` readers, joining call and message namespaces by Session identity. Missing providers return explicit errors without changing existing ledger commands. Human sends have no invented sender Session; the delivery provider binds the invocation's authority.

`send` accepts exactly one explicit Session or exact name, a class, and text; priorities default to `steer` for handoffs/replies and `queue` for notices. Replies require `--reply-to`. Controls read the current revision unless `--expected-revision` is supplied, retain an explicit `--operation-id` when provided, and distinguish pending-owner intent from applied decisions. `send-batch --dry-run` and `resolve` call only the read-only resolver, never mailbox publication or wakeup.

`quarantined --target-session ID` separately queries verified mailbox isolation events through the optional delivery reader. Node, time, cursor and limit filters are supported; lifecycle-state filters are rejected. No message bodies are exported, no writes occur, and older providers without this capability return exit 3 rather than an invented empty result.

`unanswered --older-than-minutes N` forwards handoff/reply age filters to the journal projection; withdrawn, invalidated, rejected, and previously responded messages are excluded unless terminal auditing applies. JSONL exports retain stable creation-time/node/message ordering, schema version, exclusive next cursor, and full-scan integrity, and omit message bodies. `--output` creates a new owner-only file; omission returns JSONL in the structured result. `watch --session ID` streams receipt JSONL and supports an exclusive `--cursor`.

Message command exit statuses are 0 for success or durable pending-owner intent, 1 for execution failure, 2 for invalid arguments, 3 for unavailable capabilities, 4 for delivery/control refusal, 5 for a missing operation or a typed missing-message failure, and 6 for incomplete journal scans. stdout stays machine-readable JSON. `send`, `send-batch`, `withdraw`, `edit`, `reprioritize`, `invalidate`, `status`, `operation`, and `resolve` also write one plain-language English sentence to stderr; refusals name the reason and the current state when the runtime reported one. Exact-seat `offline` and `busy-not-accepting` results retain their distinct explanations without changing command addressing.

<a id="model-experience"></a>
## Model Experience

### Read-only query service

#### What the model sees

`src/index.ts` registers no tools, prompts, or messages, so the model receives no content from this package.

#### Token effect

The query service dispatches no model requests and adds no input or output tokens.

#### KV Cache effect

The query service neither modifies request prefixes nor creates or refreshes cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This package supplies declarations and a query service only; storage, network requests, process observation, command execution, and profile composition are not implemented here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
