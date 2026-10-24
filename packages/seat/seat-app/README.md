---
description: "Explicit seat CLI profile and opt-in provider composition."
kind: "package-bundle"
---

# @panedesk/dsh-seat-app

English | [中文](README.zh.md)

## Summary

Runs one seat command through the shared launcher and [seat services](../../../docs/subsystems/seat.md). Select `panedesk --profile seat`; installing the bundle does not change the default profile or install a background service.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The profile layers the base bundle and this bundle. Its patch declares the ledger, scheduler, seat providers, policies, tools, Remote adapter, and command consumer. The scheduler's Session controller uses host-only workspace, upload, and carrier-neutral connection services; no Web server or browser application is mounted. The engine row is disabled until an explicit overlay enables it with a complete deployment policy; no private limits or automatic-opening policy are supplied. Webhook ingress remains unconfigured, and config watching is disabled for the command application.

Commands default to `list`. Manual `open` defaults to `prefill`; automatic opening requires an explicit choice. Batches name each seat explicitly. Structured operations accept `--request` JSON, mutually exclusive with field options; mutation callers can retain `--operation` identities. Invalid input, unavailable providers, and refused operations return status 2; success returns 0. stdout carries a JSON result.

The command waits for `appReady`. Disposal removes the readiness listener and drains the running command. It does not own the engine journal or bypass provider readiness.

<a id="model-experience"></a>
## Model Experience

### Command results

#### What the model sees

CLI output is not model context. `prefill` returns a draft without starting a model turn; providers own content delivered by explicitly requested operations.

#### Token effect

Parsing and printing add no model tokens. Explicit automatic opening, waking, or renewal can request provider-owned model work.

#### KV Cache effect

The application does not rewrite model prefixes or refresh caches itself. Requested operations retain the selected provider's cache behavior.

## Known Limitations and Deferred Work

- A working local provider is required. Without the engine, `nodeStatus` reports configured identity, `engine: 'unavailable'`, zero open engine windows and null limit/readiness; `list` and engine management remain unavailable. `import.preview` and `import.commit --request` can run in separate processes using the same home and retained `planId`; source or catalog changes require another preview.
- This bundle does not install an operating-system service or offer cross-node live execution.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep command dispatch behind launcher readiness and provider authority; do not add a separate executable or inline replacement engine.

</details>
