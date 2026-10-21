---
description: "One-shot task bundle for the Panedesk slim preset."
kind: "package-bundle"
---

# @panedesk/slim-headless

English | [中文](README.zh.md)

## Summary

`@panedesk/slim-headless` layers the `@panedesk/dsh-headless` one-shot runner over `@panedesk/slim-base` with Panedesk defaults. It is installed with the `panedesk` launcher for users running one task at a time on the default slim preset. It is a profile bundle, not a separate executable: invoke it through `panedesk "task"`, which uses the slim core and this runner to print the final answer and exit.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### One-shot task composition

#### What the model sees

This bundle configures the system prompt coding-agent persona, disables the harness identity line, and uses the headless runner to submit the user task. The model receives the persona for the selected model name and the task; the provider and model must first be configured through the profile or an overlay.

##### Persona prefix

```markdown
You are a coding agent powered by the {{model}} model.
```

#### Token effect

Each invocation submits the task text and includes the persona without the harness identity line; token counts vary with the task and configured model name.

#### KV Cache effect

The persona prefix stays stable while its configuration is unchanged. Changes to the model name, persona, or tool mode can change that prefix; user tasks append after it, and the provider controls cache availability and eviction.

## Known Limitations and Deferred Work

- Slim ships no model route; configure a provider overlay before running a task. The runner handles one task per invocation rather than an interactive follow-up session.

### Dev Note

`cordis.patch.yml` applies after the slim core; this bundle supplies no separate command and must not implicitly select a default model route.
