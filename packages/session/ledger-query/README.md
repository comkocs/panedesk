---
description: "Read-only ledger query and export service definitions."
kind: "package-reference"
---

# @panedesk/dsh-ledger-query

English | [中文](README.zh.md)

## Summary

Read-only ledger query and export service definitions. The package exposes an abstract Cordis service and public types. A concrete provider must implement the operations before consumers can use them.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Import public types from the package entry. The package is Host-only and does not provide a browser entry. Call queries and exports consume the ledger provider's incrementally maintained snapshot; descendant selection builds one parent-child index, and liveness selection indexes observations once per read. Merge comparison serializes facts only for repeated row identities; unique rows still receive the same wait projection and stable ordering. Integrity rejection, stable ordering, watermarks and export encodings remain unchanged.

`panedesk --profile ledger engine` dispatches `events`, `gates`, `pending`, `export`, and `verify` through optional seat providers. Events retain exclusive cursors, completeness and committed watermarks; engine records remain separate from accounting and message journals. Export requires an explicit JSONL output path; verification never executes imported operations. Missing providers do not change existing accounting or message commands.

`panedesk --profile ledger messages --help` lists strict message commands. Delivery commands use the optional `messageDelivery` service; message queries use the optional ledger `queryMessages` and `querySessions` readers, joining call and message namespaces by Session identity. Missing providers return explicit errors without changing existing ledger commands. Human sends have no invented sender Session; the delivery provider binds the invocation's authority.

`send` accepts exactly one explicit Session or exact name, a class, and text; priorities default to `steer` for handoffs/replies and `queue` for notices. Replies require `--reply-to`. Controls read the current revision unless `--expected-revision` is supplied, retain an explicit `--operation-id` when provided, and distinguish pending-owner intent from applied decisions. `send-batch --dry-run` and `resolve` call only the read-only resolver, never mailbox publication or wakeup.

`unanswered --older-than-minutes N` forwards handoff/reply age filters to the journal projection; withdrawn, invalidated, rejected, and previously responded messages are excluded unless terminal auditing applies. JSONL exports retain stable creation-time/node/message ordering, schema version, exclusive next cursor, and full-scan integrity, and omit message bodies. `--output` creates a new owner-only file; omission returns JSONL in the structured result. `watch --session ID` streams receipt JSONL and supports an exclusive `--cursor`.

Message command exit statuses are 0 for success or durable pending-owner intent, 1 for execution failure, 2 for invalid arguments, 3 for unavailable capabilities, 4 for delivery/control refusal, 5 for a missing operation or a typed missing-message failure, and 6 for incomplete journal scans. stdout stays machine-readable JSON. `send`, `send-batch`, `withdraw`, `edit`, `reprioritize`, `invalidate`, `status`, `operation`, and `resolve` also write one plain-language English sentence to stderr; refusals name the reason and the current state when the runtime reported one.

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
