---
description: "Minimal core bundle for the Panedesk slim preset."
kind: "package-bundle"
---

# @panedesk/slim-base

English | [中文](README.zh.md)

## Summary

`@panedesk/slim-base` supplies the minimal headless core, context compaction, large-output spill, tool-call timeout guard, and `AGENTS.md` loading as a row-for-row subset of `@panedesk/dsh-base`. It is the core bundle for users of the default slim preset and is installed with the `panedesk` launcher. It supplies profile composition rather than a separate command; `panedesk "task"` selects slim, together with the `@panedesk/slim-headless` one-shot bundle.

## Known Limitations and Deferred Work

- This bundle is only a subset of the full composition; slim ships no model route, so users must configure a provider overlay before running a task.
