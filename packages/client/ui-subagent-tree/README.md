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

The Panedesk features page exposes **External subagent registry file**, stored globally in the active profile's `cordis.patch.yml` as `ui-subagent-tree.externalRegistryFile` and `externalRegistryEnabled`. External reads default to off; the switch preserves the saved path when turned off. Enter a host-readable UTF-8 JSONL file for your dispatch script; path edits save immediately and enable nonempty paths. Desktop's **Choose file** uses the window-owned Electron file picker and saves the absolute selection; Web has no picker. The row shows the registry and configuration paths and directories with inline open/reveal actions. Each refresh reads that file, skips malformed lines, keeps the last valid record per `子会话号`, then selects `父会话号` equal to the displayed session. External nodes are marked leaves alongside built-in children. Their title uses `短题` or `类型`, their model uses `实际模型` or `模型`, and their monitoring view uses `起止时刻.起` / `起止时刻.止` when present, otherwise `起` / `止`. `在途` means running; missing `状态` means ended; an ended record is completed only when `退出码` is zero. Token totals sum each model's `inputTokens + outputTokens` in `用量`. Unreadable files show a warning without hiding native nodes, and later refreshes retry. Open monitoring dialogs follow refreshed values.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host exposes `subagentTree.read(request)` for authenticated-owner reads and `subagentTree.stopExternal(request)` to stop the latest external record's `启动器PID` and `PID` process trees. Windows uses `taskkill /PID <pid> /T /F`; other systems send SIGKILL to the process group, then the individual process if needed. A successful stop appends the copied record with `状态: "结束"`, `备注: "停道:主窗手动"` and a local ISO timestamp in `起止时刻.止`. The browser's injected `subagentTreeUI` shares model colors and child-first native interruption with the map; native Stop calls `subagents.interruptByParent` per child and `session.cancel` for the root. Acknowledgement means interruption was admitted; refreshed terminal facts display Stopped. The tree reads a deduplicated `sessionLedger` snapshot directly (it does not modify `ledger-query`): membership follows `parentSessionId` chains that reach the requested session, cycles degrade to exclusion, and ledger row order is the observation order. Per-session token columns sum call finishes with usage; short-tier writes exist only when a call proves tiered cache writes, untiered writes keep only their total, and cache hit rate is cache-read over uncached input plus cache-read plus observed writes with a zero denominator unknown. Status is `finished` with the ledger end reason when a latest run residency has a finish, else `waiting` while an unpaired `wait/start` has no `wait/end`, else `running` only while the latest run has started and not ended, otherwise `idle`; liveness comes from process observations. A closed own-session turn clears an otherwise running residency to idle, while an aborted turn supplies the stopped state until a new turn starts. Built-in activation writes its parent-linked run start before execution and retains the terminal row after settlement, including preset-selected children. The model id and latest tool invocation fold the session's own log suffix through `sessionQuery.readSession`, skipping the fork-inherited prefix; request headers expose the observed route before the first assistant response, whose reported model then takes precedence; a missing `sessionQuery` marks the model unavailable and an unreadable log marks it unreadable — both stay unknown on the wire.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Read-only session tree

#### What the model sees

Nothing. `subagentTree.read(request)` reads the ledger and transcripts for client UI; it sends no prompt section and calls no model-facing tool.

#### Token effect

None. Reads add zero model tokens.

#### KV Cache effect

None. Reads never edit request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Transcript reads are serial and unbounded** — each read polls every tree node's own log suffix through `sessionQuery.readSession` in ledger order; a wide tree lengthens one read and no per-node bound is imposed yet.
- **Waiting is wait-pair counting** — `waiting` compares unpaired `wait/start` and `wait/end` auxiliary facts; a provider that never pairs waits shows `running`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
