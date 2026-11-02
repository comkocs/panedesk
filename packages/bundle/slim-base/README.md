---
description: "Minimal core bundle for the Panedesk slim preset."
kind: "package-bundle"
---

# @panedesk/slim-base

English | [中文](README.zh.md)

## Summary

`@panedesk/slim-base` supplies the minimal headless core, context compaction, large-output spill, tool-call timeout guard, and `AGENTS.md` loading as a row-for-row subset of `@panedesk/dsh-base`. It is the core bundle for users of the default slim preset and is installed with the `panedesk` launcher. It supplies profile composition rather than a separate command; `panedesk "task"` selects slim, together with the `@panedesk/slim-headless` one-shot bundle.

Sandbox mode comes from the shared [policy resolver](../../sandbox/sandbox-policy/README.md), including its Windows read-only default; this bundle does not insert a writable fallback.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Slim core composition

#### What the model sees

The `cordis.patch.yml` rows compose core plugins, including system prompts, tools, context compaction, and tool-result pruning. Their configuration and the current Session determine the visible context; this bundle makes no independent model request.

#### Token effect

The bundle has no fixed independent token overhead; composed prompts and tools add request tokens, while compaction and pruning can replace retained context.

#### KV Cache effect

The bundle retains the message-only ledger entry and also mounts the complete call ledger and cache layer in the same Harness home. Cache defaults freeze the initial system/tool prefix and request Anthropic 1h or DeepSeek automatic caching. `retention: none` disables cache control, not prefix freezing. Compacted or pruned history can replace request tokens and prevent reuse of affected prefixes.

## Known Limitations and Deferred Work

- This bundle is only a subset of the full composition; slim ships no model route, so users must configure a provider overlay before running a task.

### Dev Note

`cordis.patch.yml` is generated from the upstream base configuration by `scripts/panedesk/gen-slim-base.ts`; update its source and regenerate rather than editing the generated configuration.
