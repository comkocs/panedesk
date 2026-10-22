---
description: "Session cache policy and concurrency plugin scaffold."
kind: "package-reference"
---

# @panedesk/dsh-llm-cache

English | [中文](README.zh.md)

## Summary

Session cache policy and concurrency plugin scaffold. The package exposes validated configuration and an inert function plugin. Loading it registers no hooks, timers, commands, or services.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Import public types from the package entry. The package is Host-only and does not provide a browser entry.

An active inbox insertion retains the existing `interjection` cache breakpoint. An `interjection` abort settles the interrupted call as `cancelled` with `upstreamStopReason: 'interjection'`, preserves partial-response artifacts, and records the breakpoint on the interrupted call and its continuation. Ordinary user cancellation remains distinct. Upstream prefix reconstruction is not suppressed: committed history replacement retains `history-edit`, and changed request headers retain `request-config-change`; each call records its actual prefix fingerprint.

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
