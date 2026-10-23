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

Set `PANEDESK_SEAT_MAX_DECISION_BYTES` to the target writer's `maxDecisionBytes` to enable the `seat-engine-query` reader, or override that row with explicit `home`, `nodeId`, and `maxDecisionBytes` in a profile patch. No frame limit is inferred from a test fixture. Without the setting, ordinary ledger commands remain available and engine queries report unavailable. Engine commands disable local message delivery so loading them cannot initialize mailboxes. The reader supports `engine events`, `pending`, `export`, and `verify` without mounting the writer; export returns JSONL in `content` and never writes its output path. `engine gates` reports unavailable because no mutable gate provider is mounted; historical gate facts remain queryable through events.

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
