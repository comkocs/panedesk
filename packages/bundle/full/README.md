---
description: "Optional full preset carrier for the Panedesk launcher."
kind: "package-bundle"
---

# @panedesk/full

English | [中文](README.zh.md)

## Summary

`@panedesk/full` carries the upstream DSH headless composition, web/ACP/SDK apps, optional bundles, and plugin manager. Users who need these beyond the default slim preset install it beside the `panedesk` launcher to enable the `full`, `web`, `acp`, and `sdk` profiles. It supplements the launcher rather than providing a separate command; run `panedesk full` to select the full headless preset.

## Known Limitations and Deferred Work

- This optional carrier must be installed beside the launcher; installing the slim launcher alone does not make the full profiles available.
