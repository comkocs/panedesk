---
description: "Opt-in node-local seat orchestration and its providers and consumers."
kind: "package-group"
---

# seat/ — Optional seat orchestration

English | [中文](README.zh.md)

## Summary

Defines named seat configurations and node-local window operations, durable admission and recovery, optional policies, and CLI, Remote, and model consumers. Installation does not enable automatic opening or install a background service.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`seat/`](seat/README.md) | Shared service definitions and operation types |
| [`seat-local/`](seat-local/) | Local definitions and Session operations |
| [`seat-engine/`](seat-engine/README.md) | Durable queues, recovery, resource budgets, and callbacks |
| [`seat-gates/`](seat-gates/README.md) | Optional policies, memory audit, and checkpoint consumers |
| [`tool-seat/`](tool-seat/README.md) | Model-facing window, wait, report, and directory tools |
| [`seat-remote/`](seat-remote/README.md) | Authenticated Remote projection and optional webhook ingress |
| [`seat-app/`](seat-app/README.md) | Explicit launcher profile bundle and CLI consumer |

<a id="related-documentation"></a>
## Related documentation

- [Seat subsystem](../../docs/subsystems/seat.md) owns the group's type definitions and service semantics.
- [Configuration catalog](../../docs/config-catalog.md) records provider configuration.
- [Tool catalog](../../docs/tool-catalog.md#panedeskdsh-tool-seat) records model tool schemas.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Local and engine providers depend on shared service definitions, not each other's implementations. Engine records remain separate from Session, accounting, and message journals.

</details>
