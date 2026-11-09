---
description: "Subagent parent-child tree with per-node monitoring and Stop controls for the dsh web client."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-subagent-tree

English | [中文](README.zh.md)

## Summary

Open a session's subagent tree from its header into a right-sidebar tab. Nested rows show state, model, token totals and cache hit rate. Each Monitor button opens read-only status (running, waiting or end reason), model, five token columns, cache hit rate, elapsed time, latest tool invocation and time, seat and linked task. Active rows offer a red Stop button without confirmation; it interrupts the selected session and its active descendants child-first. Running and waiting nodes have green dots, while inactive nodes have gray dots. Model names use five shared colors: Claude blue, GPT orange, GLM green, DeepSeek amber and other models pink. Built-in model names come from the latest observed request header or assistant response in the session transcript, never from configured ledger defaults. External names come from dispatch records; missing names stay unknown.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The compact 28px pill preserves the existing header height and appears only inside an open session's header actions band, after the subagent catalog pill; it is absent for the `minimal` preset and contributes no first-screen or guide-page entry. Picking it opens this session's tree page in the right Sidebar as the `subagenttree` tab kind, addressed `dsh-resource://subagenttree/session/<sessionId>`. The tab polls the `subagentTree.read` Remote at the deployment's refresh cadence and renders the eight states (idle, loading, empty, error, unauthorized, disabled, success, failed) with bilingual copy. A node row indents by tree depth, prefixes its state dot, and shows the label from the session projection (falling back to the session id). Monitoring facts state each value or its explicit unknown; usage evidence coverage (`missing` / `partial` / `complete`) is shown rather than zero-filled.

The Panedesk features page exposes **External subagent registry file**, stored globally in the active profile's `cordis.patch.yml` as `ui-subagent-tree.externalRegistryFile` and `externalRegistryEnabled`. External reads default to off; the switch preserves the saved path when turned off. Enter a host-readable UTF-8 JSONL file for your dispatch script; path edits save immediately and enable nonempty paths. Desktop's **Choose file** uses the window-owned Electron file picker and saves the absolute selection; Web has no picker. Three first-use steps explain preparing the file, setting its path and inspecting the tree; the AI request uses `panedesk_settings` to read and update the two registry preferences. The row shows the registry and configuration paths and directories with inline open/reveal actions. Each refresh reads that file, skips malformed lines, keeps the last valid record per `子会话号`, then selects `父会话号` equal to the displayed session. External nodes are marked leaves alongside built-in children. Their title uses `短题` or `类型`, their model uses `实际模型` or `模型`, and their monitoring view uses `起止时刻.起` / `起止时刻.止` when present, otherwise `起` / `止`. `在途` means running; missing `状态` means ended; an ended record is completed only when `退出码` is zero. Token totals sum each model's `inputTokens + outputTokens` in `用量`. Unreadable files show a warning without hiding native nodes, and later refreshes retry. Open monitoring dialogs follow refreshed values.
