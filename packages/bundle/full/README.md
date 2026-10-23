---
description: "Optional full preset carrier for the Panedesk launcher."
kind: "package-reference"
---

# @panedesk/full

English | [中文](README.zh.md)

## Summary

`@panedesk/full` carries the upstream DSH headless composition, web/ACP/SDK apps, optional bundles, and plugin manager. Users who need these beyond the default slim preset install it beside the `panedesk` launcher to enable the `full`, `web`, `acp`, and `sdk` profiles. It supplements the launcher rather than providing a separate command; run `panedesk full` to select the full headless preset.

The optional `seat` profile resolves its seat packages through this carrier and the [seat application bundle](../../seat/seat-app/README.md). Installing the carrier neither selects that profile nor enables automatic opening; the engine requires explicit deployment configuration.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Explicit full profile selection

#### What the model sees

This package carries dependencies without inserting prompt text or tool schemas directly. The plugins composed by the explicitly selected `full` profile own the model context; installing this carrier alone does not change `slim` requests.

#### Token effect

The carrier adds zero direct request tokens; after explicit profile selection, the mounted plugins own the token usage.

#### KV Cache effect

Installing the carrier alone does not replace a request prefix. Switching profiles changes the composed prompts and tools and may prevent reuse of an existing prefix; cache availability remains provider-owned.

## Known Limitations and Deferred Work

- This optional carrier must be installed beside the launcher; installing the slim launcher alone does not make the full profiles available.

### Dev Note

The dependency manifest owns this carrier's published contents; the empty module entry exports no runtime API. Dependency changes must preserve the launcher's on-demand full-profile resolution.
