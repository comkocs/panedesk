---
description: "Ledger checkpoint projection and compaction-event ownership."
kind: "package-reference"
---

# @panedesk/dsh-compaction-ledger

English | [中文](README.zh.md)

## Summary

Ledger-backed checkpoint contributions and post-commit compaction facts. When a ledger is available, the plugin registers as its sole compaction-event owner; call accounting retains physical summary requests without writing a second event. Unloading releases ownership. Without a ledger, checkpoints pass through unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Import public types from the package entry. The package is Host-only and does not provide a browser entry.

<a id="model-experience"></a>
## Model Experience

### Ledger checkpoint

#### What the model sees

The committed checkpoint includes bounded `<ledger-checkpoint-data>`, including live child identities, explicitly marked as untrusted runtime data.

#### Token effect

Checkpoint data consumes the configured token budget but dispatches no additional model requests.

#### KV Cache effect

The checkpoint changes compacted history; the plugin does not create or refresh provider cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Post-commit ledger failures are reported without rolling back the checkpoint. Durable storage and physical model-call accounting belong to the ledger provider.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
