---
description: "Offline ledger application plugin scaffold."
kind: "package-bundle"
---

# @panedesk/dsh-ledger-app

English | [中文](README.zh.md)

## Summary

Offline ledger application bundle. Its patch mounts the session ledger, query service, and local message delivery with Agent and Session registries, projection, and JSONL persistence. Delivery takes its node identity from the ledger. The bundle does not mount a model adapter, Agent loop, or instruction subscriptions; an offline command creates no running model Session.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Import public types from the package entry. The package is Host-only and does not provide a browser entry.

Before a query, stderr reports availability from the latest main-process `$PANEDESK_HOME/run/kernel-status.json`: `Session ledger not mounted: <details>` for an unavailable ledger, `Accounting cache layer not mounted: <details>` for a cache-only failure, or `Accounting status unavailable: <cause>` when status cannot be read. If both services are unavailable, the ledger heading lists both. A missing local query service reports `Ledger query unavailable: <cause>`. `(may be stale)` marks an exited pid or a status older than `run/kernel-boot.json`. Offline queries never overwrite the main-process files. Missing local `ledgerQuery` reports its disabled, import, or pending-injection cause and exits 1. stdout retains machine-readable JSON; existing command diagnostics are English.

Set `PANEDESK_SEAT_MAX_DECISION_BYTES` to the target writer's `maxDecisionBytes`, or set `engineReader` on the `ledger-app` row with explicit `home`, `nodeId`, and `maxDecisionBytes`. Only `engine` command arguments mount the engine and gate readers; other commands retain the default plugin rows and services. No frame limit is inferred. Without reader configuration, engine queries report unavailable. Engine commands disable local message delivery to avoid initializing mailboxes. The readers support `engine events`, `pending`, `export`, `verify`, and `gates` without mounting the writer; export returns JSONL in `content` and never writes its output path. Gate queries rebuild each recorded revision's hit count, expiration and limit evidence from one verified journal prefix. Unrecorded policies are omitted and unrecorded limits are `unknown`; worktree client limits use recorded counts and bounds. Pagination cursors belong to the observed watermark and become invalid after a new commit.

<a id="model-experience"></a>
## Model Experience

### Offline command composition

#### What the model sees

`src/index.ts` registers no tools, prompts, or messages, so the model receives no content from this package.

#### Token effect

The scaffold dispatches no model requests and adds no input or output tokens.

#### KV Cache effect

The scaffold neither modifies request prefixes nor creates or refreshes cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This composition does not run recipient Agents; online recipients belong to another running profile. Instruction subscriptions are omitted because offline queries have no input-preparation lifecycle.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
