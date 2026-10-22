---
description: "Inactive instruction observation consumer scaffold."
kind: "package-reference"
---

# @panedesk/dsh-instruction-subscriptions

English | [中文](README.zh.md)

## Summary

Inactive instruction observation consumer scaffold. The named `apply` function performs no work and registers no listeners or services. See [Session persistence](../../../docs/subsystems/persistence.md).

## Table of Contents

- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="dev-note"></a>
## Dev Note

`src/index.ts` owns the public declarations; keep both README languages and package contract tests aligned with changes.

<a id="model-experience"></a>
## Model Experience

### Inactive scaffold

#### What the model sees

`apply` emits no messages, tools, or prompt sections.

#### Token effect

Zero direct token consumption.

#### KV Cache effect

No requests or model-visible prefixes are modified.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The instruction observation consumer is not implemented. Loading this scaffold does not activate message delivery or instruction subscriptions.
