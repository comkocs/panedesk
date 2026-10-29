---
description: "Same-node message delivery service definitions."
kind: "package-reference"
---

# @panedesk/dsh-message-delivery

English | [中文](README.zh.md)

## Summary

Service Definition for same-node messages, receive settings, durable controls, and runtime-owned receipts. The abstract `MessageDelivery` service exposes `ctx.messageDelivery`; it does not implement storage or delivery. See [Session persistence](../../../docs/subsystems/persistence.md).

`list` opts into strict pagination with `pagination: true`, a positive safe-integer `limit`, and a provider-issued exclusive `cursor`; keep the same filters when continuing a live scan. Omitting or disabling pagination preserves the provider's legacy query behavior; see the [local provider](../message-delivery-local/README.md). Unanswered queries select handoff/reply messages without a response and exclude terminal outcomes by default. Read `complete` and `nextCursor` rather than treating an incomplete scan as an empty complete result.

## Table of Contents

- [Public API](#public-api)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="public-api"></a>
## Public API

`send`, `withdraw`, `edit`, `reprioritize`, `invalidate`, `status`, `operationStatus`, `list`, `resolve`, `sendBatch`, `configure`, and `subscribe` are declared in `src/index.ts`. Public inputs and results are exported from `src/types.ts`. A closed recipient can reject delivery while retaining a queued message; an offline control acknowledges durable intent, not completed arbitration. Subscription iteration releases resources on return or service disposal.

`RoutedSendMessageRequest` extends the legacy send input with a frozen sender identity, message ID, delivery ID, digest and optional call/causal references. The optional `routedDeliveryVerifier` validates a host-owned exact-envelope capability; wire fields never grant authority. Receivers preserve these identities and acknowledge only after durable admission.

Optional `resolveSeat` and `listOnlineSeats` expose local seat resolution and busy/idle observations without widening existing address inputs. Providers may omit them; consumers must reject missing capabilities rather than infer availability. They do not change message or ledger formats.

`message/settings` is a required persistent event. `message/state` is emitted only after a durable receipt commits. Message lifecycle records belong to the separate message ledger namespace, not the call journal.

<a id="dev-note"></a>
## Dev Note

`src/index.ts` owns the public declarations; keep both README languages and package contract tests aligned with changes.

<a id="model-experience"></a>
## Model Experience

### Abstract service

#### What the model sees

`ctx.messageDelivery` declares an abstract service without publishing model context.

#### Token effect

Zero direct tokens; no tools or prompt sections are registered.

#### KV Cache effect

No requests or model-visible prefixes are changed by loading these definitions.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Delivery, owner arbitration, storage validation, and receipt production require a provider. This package does not claim that a message was delivered or responded to.
