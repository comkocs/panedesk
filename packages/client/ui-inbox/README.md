---
description: "Owner-authorized received message metadata and mailbox isolation warnings."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-inbox

English | [中文](README.zh.md)

## Summary

Adds a read-only inbox to the existing Session header. The initial home screen has no inbox entry. The [message delivery provider](../../session/message-delivery-local/README.md) owns message states, metadata and isolated evidence; this plugin neither sends messages nor opens Sessions. See [Session persistence](../../../docs/subsystems/persistence.md).

## Configuration and use

The Web bundle includes an inert `ui-inbox` row; a product profile enables it with `config: { enabled: true }`. `enabled` defaults to false, `pollIntervalMs` to 1000 and `pageSize` to 100. The Host exposes only an owner-authorized observation stream for an exact receiving Session. Missing query capabilities report unavailable; a disabled adapter returns an explicit disabled observation. No delegated identities or caller-supplied sender authority are accepted.

The inbox shows sender seat when the existing owner-authorized binding query supplies it, otherwise human or unknown attribution, creation time, priority and the six existing message states. Rows sort by creation time then message identity. Only routing metadata is requested; message bodies, paths and credentials are excluded. A warning appears only when the requested mailbox has verified isolation evidence; opening it displays localized reasons. No quarantine state is added to the lifecycle enumeration.

The panel distinguishes default, loading, empty, error, unauthorized, disabled, success and failed refresh observations. Partial results remain explicitly incomplete. Resources own subscription lifetimes; closing the modal does not create a separate polling loop. Plugin disposal removes the Remote mount and all UI, resource and locale contributions.

## Model Experience

### Read-only observation

#### What the model sees

No tools, prompts or Session messages are added.

#### Token effect

Inbox reads consume no model tokens.

#### KV Cache effect

The plugin neither changes request prefixes nor refreshes caches.

## Known Limitations and Deferred Work

- The adapter covers the authenticated owner and local provider, not delegated cross-node browsing.
- Older providers without isolation queries report unavailable rather than inventing an empty inbox. Older statuses without metadata retain unknown fields.
- Polling observes live pages, not an atomic multi-page snapshot. Missing historical seat bindings remain unknown.

## Dev Note

The browser reads only the standard resource seat. The Host filters existing delivery queries by receiving Session and uses existing owner authority for optional seat labels.
