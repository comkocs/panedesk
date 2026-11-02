---
description: "Authenticated Remote seat operations and opt-in webhook ingress."
kind: "package-reference"
---

# @panedesk/dsh-seat-remote

English | [中文](README.zh.md)

## Summary

Projects the [seat services](../../../docs/subsystems/seat.md) through the `seats` Remote namespace. Business operations remain in the node-local providers; this package does not create a replacement engine.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount beside the authenticated Remote runtime and seat providers. Calls require the owner principal. The adapter derives authority from the invocation and local engine identity, rejects injected authority fields, and forces remote opening through the automatic provider path. Missing providers return explicit unavailable errors.

Webhook ingress is absent unless `webhook` is configured with a path, bounded body and response timing policy, accepted clock skew, and explicit sources referencing credentials. Each configured source is registered with the engine under the same identity as its HTTP allowlist entry; unloading removes both the route and source registrations after draining requests. Valid signatures enter durable admission; invalid signatures only produce rejection audits. External sources without a `callback` destination only record completion in the engine ledger; they send no outbound receipt. A source can register `callback: { url, keyVersion }` with an HTTP(S) destination and a version in its own `credentialRefs`; URL user information is rejected. Receipts POST the unchanged frozen payload with `idempotency-key: <callbackId>` and `x-seat-source`, `x-seat-timestamp`, `x-seat-key-version`, and `x-seat-signature` headers. The signature is HMAC-SHA256 over `<timestamp>.` followed by the raw JSON body, using the credential resolved by reference. Delivery uses the installed engine's `callbackTimeoutMs` and `callbackMaxResponseBytes`, never follows redirects, and retains no response text. Receivers must reject authentication before processing: 401/403 therefore report `callback-authentication-failed` with `effectState: none`. The engine parks this callback for manual resolution without stopping independent callbacks, unless retained evidence includes an earlier uncertain outcome. Completed bounded 2xx responses succeed; 401/403 pause authentication, other 4xx and redirects pause protocol delivery, and oversized responses pause protocol delivery unless the status is 5xx. Server, transport, timeout, and credential-provider failures remain retryable. Receivers must deduplicate by `callbackId` because delivery is at least once. Rejected source attempts are durably audited through the engine. Do not place credential values in source records or query output.

When permission presets are mounted, this adapter contributes paginated seat definition and memory directories to the owner-only legacy workspace ACL inventory. It reads metadata without opening sessions; unloading the adapter removes the directory reader.

<a id="model-experience"></a>
## Model Experience

### Remote requests

#### What the model sees

`seatRemote` responses are not model messages. Any admitted opening or wake content is owned by the seat provider and existing message delivery.

#### Token effect

Parsing, authentication, queries, and HTTP acknowledgement add no model tokens. Admitted operations may cause provider-owned model work.

#### KV Cache effect

Remote projection does not replace request prefixes or refresh caches. Provider-owned model operations retain their own cache behavior.

## Known Limitations and Deferred Work

- Live execution requires local seat providers; authenticated access does not grant cross-node execution.
- Webhook authentication and audit require the configured credential and engine services; missing evidence cannot be accepted as authenticated ingress.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep authority derivation server-side and preserve typed refusal, pagination completeness, and operation identities in projections.

</details>
