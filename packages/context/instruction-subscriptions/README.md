---
description: "Bounded instruction change reminders before input claim."
kind: "package-reference"
---

# @panedesk/dsh-instruction-subscriptions

English | [中文](README.zh.md)

## Summary

This optional plugin sends metadata-only instruction change reminders through `MessageDelivery.send` at `agent/input-preparing`, before input claim. It subscribes each agent independently to its actually loaded startup files and explicitly configured paths. Missing filesystem or delivery services leave upstream behavior unchanged. See [Session persistence](../../../docs/subsystems/persistence.md).

## Table of Contents

- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="dev-note"></a>
## Dev Note

`tests/kernel-boundary.e2e.ts` boots delivery and subscriptions through Loader with real JSONL persistence and a local HTTP model fixture. It also exercises SDK and ACP message send/status requests against that same delivery provider, launches the public ledger CLI profile for cross-process send/status, and joins real model-call accounting and message ledger records by Session.

Configure the plugin through an existing profile or patch: `files` defaults to an empty additional-path list, `maxBytes` is a required positive integer limiting each agent's retained raw bytes and each boundary's scan bytes, and `watch` defaults to false. Relative paths resolve from the agent working directory. Watch callbacks only mark dirty; every running agent's boundary still scans. Ending an agent or disposing the plugin closes watchers and discards in-memory snapshots. No previous-content files or ledger prose are written, so filesystem snapshot permissions are not applicable.

Startup load hashes initialize baselines without accepting a racing newer read as the original baseline. Successful same-agent writes suppress a reminder only when version-qualified raw-byte evidence equals the final scanned hash; unavailable evidence never suppresses a change. Parent writes do not suppress child reminders. A rejected delivery retains the old baseline for retry. Added and removed line counts use LF-normalized line comparison; missing retained bytes or unreadable/over-limit states produce null counts rather than fabricated values.

<a id="model-experience"></a>
## Model Experience

### Instruction change reminder

#### What the model sees

One appended steer-priority message contains JSON fields `kind: instruction-change`, `path`, `oldHash`, `newHash`, `status`, `added`, and `removed`. Status is `present`, `deleted`, `unreadable`, or `over-limit`; absent hashes are null. No instruction body or diff fragments are included. The delivery classification is `handoff`, because notices cannot use steer priority; sends occur only for a running subscribed agent.

#### Token effect

Each detected change adds one metadata message through the ordinary logged delivery path. Unchanged files and evidenced self-writes add no reminder tokens.

#### KV Cache effect

The plugin appends reminders and never replaces the request prefix or reloads instruction text. Upstream instruction recomposition remains enabled independently; any prefix effects it produces remain upstream behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Post-write evidence is a bounded, version-qualified later read, not an atomic write-time digest; races can cause an extra reminder.
- Detection requires the host's awaitable pre-claim event and a delivery provider. Watch failures fall back to boundary scans, not a background reload.
- Snapshots are process-local and byte-bounded. An unavailable prior snapshot yields unknown line counts. Restart establishes fresh subscriptions.
