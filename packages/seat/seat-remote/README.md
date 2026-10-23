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

Webhook ingress is absent unless `webhook` is configured with a path, bounded body and response timing policy, accepted clock skew, and explicit sources referencing credentials. Rejected source attempts are durably audited through the engine. Do not place credential values in source records or query output.

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
