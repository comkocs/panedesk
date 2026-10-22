---
description: "Durable call and lifecycle ledger service definitions."
kind: "package-reference"
---

# @panedesk/dsh-session-ledger

English | [中文](README.zh.md)

## Summary

Durable call and lifecycle ledger service definitions. The package exposes an abstract Cordis service and public types. A concrete provider must implement the operations before consumers can use them.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Import public types from the package entry. The package is Host-only and does not provide a browser entry.

Providers accept `Config.waitTools` and implement `registerWaitTool(name, category)` for trusted runtime classifications (`sleep`, `external-marker`, `subagent`). Runtime registrations override configured defaults; conflicting live categories reject, and the idempotent disposer releases only its registration. Unregistered tools remain `unclassified`; model output never defines a category.

`appendArtifact` writes restricted `partial-response` or `keepalive-request` JSON fragments under ledger-owned paths. `(callId, kind, seq)` identifies exact UTF-8 content bytes: equal replays return `existing`, unequal bytes return `conflict` without overwriting. Sequences start at zero and remain contiguous. Success follows file and required directory synchronization. `finishArtifact` verifies the last fragment and durably closes the stream; later new fragments reject, while exact replays remain idempotent. `LedgerCallFinish.artifacts` carries the returned references, not raw content.

`JournalSessionLedger.messages()` stores body-free `message/state` facts in `ledger/messages/v1/<nodeId>/events/<UTC-date>/`, independently of the unchanged call namespace `ledger/v1/`. Message envelopes start at `schemaVersion: 1`; human origins may have no Session or run. Event identities derive from node, message, state version, and transition. A native writer lock serializes unique state versions; equal replays synchronize and acknowledge existing bytes, unequal replays reject. Each append creates a restricted checksummed JSONL segment and fsyncs it and its directory. Interrupted tails remain untouched, later writes use new segments, and reads report incomplete storage rather than hiding tails or corruption. Message bodies are rejected.

<a id="model-experience"></a>
## Model Experience

### Inactive scaffold

#### What the model sees

`src/index.ts` registers no tools, prompts, or messages, so the model receives no content from this package.

#### Token effect

The scaffold dispatches no model requests and adds no input or output tokens.

#### KV Cache effect

The scaffold neither modifies request prefixes nor creates or refreshes cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This package supplies declarations and a scaffold only; storage, network requests, process observation, command execution, and profile composition are not implemented here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
