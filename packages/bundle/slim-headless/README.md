---
description: "One-shot task bundle for the Panedesk slim preset."
kind: "package-bundle"
---

# @panedesk/slim-headless

English | [中文](README.zh.md)

## Summary

`@panedesk/slim-headless` layers the `@panedesk/dsh-headless` one-shot runner over `@panedesk/slim-base` with Panedesk defaults. It is installed with the `panedesk` launcher for users running one task at a time on the default slim preset. It is a profile bundle, not a separate executable: invoke it through `panedesk "task"`, which uses the slim core and this runner to print the final answer and exit.

## Known Limitations and Deferred Work

- Slim ships no model route; configure a provider overlay before running a task. The runner handles one task per invocation rather than an interactive follow-up session.
