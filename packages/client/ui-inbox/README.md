---
description: "Owner-authorized received message metadata and mailbox isolation warnings."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-inbox

English | [中文](README.zh.md)

## Summary

Retains the dormant Host observation adapter for explicit profile consumers. The archived Client entry contributes no header button, modal, resources or Remote mount. The [message delivery provider](../../session/message-delivery-local/README.md) owns message states, metadata and isolated evidence; this plugin neither sends messages nor opens Sessions. See [Session persistence](../../../docs/subsystems/persistence.md).

## Table of Contents

- [Configuration and use](#configuration-and-use)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration and use

The Web bundle does not compose this package. An explicit profile can mount its Host adapter with `config: { enabled: true }` without restoring the removed UI. `enabled` defaults to false, `pollIntervalMs` to 1000 and `pageSize` to 100. The Host exposes only an owner-authorized observation stream for an exact receiving Session. Missing query capabilities report unavailable; a disabled adapter returns an explicit disabled observation. No delegated identities or caller-supplied sender authority are accepted.

The Host adapter returns sender attribution when the existing binding query supplies it, creation time, priority and existing message states. Only routing metadata is requested; message bodies, paths and credentials are excluded. Verified mailbox isolation evidence remains separate from lifecycle states. Partial results remain explicitly incomplete.

## Model Experience

### Read-only observation

#### What the model sees

The `ui-inbox` plugin adds no tools, prompts or Session messages.

#### Token effect

Inbox reads consume no model tokens.

#### KV Cache effect

The plugin neither changes request prefixes nor refreshes caches.

## Known Limitations and Deferred Work

- The adapter covers the authenticated owner and local provider, not delegated cross-node browsing.
- Older providers without isolation queries report unavailable rather than inventing an empty inbox. Older statuses without metadata retain unknown fields.
- Polling observes live pages, not an atomic multi-page snapshot. Missing historical seat bindings remain unknown.

### Dev Note

The no-op Client entry preserves existing package manifests without retaining the retired button implementation. The Host adapter and underlying message delivery are unchanged.
