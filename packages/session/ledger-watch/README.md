---
description: "Optional ledger owner reconciliation and process watching."
kind: "package-reference"
---

# @panedesk/dsh-ledger-watch

English | [中文](README.zh.md)

## Summary

Optional ledger owner reconciliation and process watching. With a Session ledger provider, the plugin reconciles the configured local node at startup or polls continuously when explicitly enabled. Disposal stops watching and waits for the current round; without a ledger provider it stays inactive.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

After durably identifying a dead owner, the watcher emits `ledger-watch/owner-settled` for that exact identity before slow call repair. Unknown owner evidence or a racing normal terminal does not authorize release. Notification failures are contained without skipping existing repair; consumers own their resource release.

Import public types from the package entry. The package is Host-only and does not provide a browser entry.

<a id="model-experience"></a>
## Model Experience

### Owner reconciliation

#### What the model sees

`src/index.ts` registers no tools, prompts, or messages, so the model receives no content from this package.

#### Token effect

The watcher dispatches no model requests and adds no input or output tokens.

#### KV Cache effect

The watcher neither modifies request prefixes nor creates or refreshes cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Reconciliation requires authoritative evidence for the configured local node; unknown process evidence does not authorize owner release. Consumers handle resource release after the durable settlement notification.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
