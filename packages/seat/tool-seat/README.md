---
description: "Optional model tools for seat windows, nonblocking waits, reports, and registered directories."
kind: "package-reference"
---

# @panedesk/dsh-tool-seat

English | [中文](README.zh.md)

## Summary

Exposes model-facing consumers of the [seat services](../../../docs/subsystems/seat.md). Window, wait, and report tools register only with `tools` and `seats`; directory tools require `tools` and `seatDirectories`. Unloading a provider removes its contributions.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside authorized providers. Operation identities derive from the calling Session and tool call. Window operations name exact seats or Sessions; closing requires the observed state version and refuses busy windows. Directory operations use registered root identities and retain provider permissions rather than accepting arbitrary authorized paths.

`seat_wait` registers explicit objects and concludes the current turn after registration. It does not sleep, poll, or await task completion. Cancelling a wait cancels observation only. Reports retain the three required fields without claiming that the runtime is idle or closed.

<a id="model-experience"></a>
## Model Experience

### Optional tool schemas

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#panedeskdsh-tool-seat) owns the complete schemas and descriptions. Availability follows provider presence; there is no separate system-prompt contribution.

#### Token effect

Installed tool schemas add request tokens only while their provider group is available.

#### KV Cache effect

A stable installed schema set preserves the repeated schema prefix. Adding or removing providers changes that set and can prevent prefix reuse.

### Structured tool results

#### What the model sees

Tools return provider results as JSON text, including committed operation identities, refusals, busy reasons, state versions, and bounded directory content where applicable.

#### Token effect

Results add conversation tokens according to the returned fields and content bounds. Wait registration returns immediately instead of consuming repeated polling turns.

#### KV Cache effect

Logged results grow append-only; the package does not replace earlier model messages or refresh caches independently.

## Known Limitations and Deferred Work

- Tools do not implement providers or bypass authority, filesystem admission, or budget checks.
- A successful report is not evidence that all runtime work has settled; close admission remains provider-owned.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep stable call attribution across retries and preserve the nonblocking wait result before concluding the turn.

</details>
