---
description: "Open, rename, list, and message top-level Sessions through existing Host services."
kind: "package-reference"
---

# @panedesk/dsh-tool-session-ops

English | [中文](README.zh.md)

## Summary

Four tools manage ordinary top-level Sessions without a Client or a separate lifecycle implementation. Web and Desktop ship them in every agent preset.

## Use this package

Mount alongside `tools`, `sessionController`, `permissionPresets`, `sessionProjections`, `workingDirectory`, `settings`, `agentDefaultModel`, and `workspaceRegistry`. The plugin has no configuration fields.

```yaml
- name: '@panedesk/dsh-tool-session-ops'
```

- `session_new({ cwd?, model?, permissionPreset?, prompt?, name? })` opens a Session. `cwd` defaults to the caller's effective directory. The existing directory is canonicalized through the Workspace registry: a matching folder group is reused, otherwise one is created before the Session is attached; relative, missing, and non-directory paths reject, as with manual folder registration; `model` matches a configured model id or display name; omitted model and permission preset retain the existing remembered defaults. `prompt` is the optional opening message. An omitted `name` does not call rename and leaves ordinary automatic naming enabled. The result contains `sessionId` and the current `name`, using the id while no title exists.
- `session_rename({ sessionId?, name })` renames the given Session, or the calling Session when the id is omitted, through the same service used by the interface. It returns `sessionId` and the accepted name.
- `session_list({})` returns all ordinary top-level Sessions, including ordinary forks but excluding delegated subagents. Each row contains `sessionId`, `name`, the effective `cwd` when available, `running`, and a `model` object with provider and model ids. Rows follow existing most-recent-activity ordering.
- `session_send({ target, text })` resolves an exact Session id first, then an exact name; duplicate names select the most recently active Session. It submits a `next-step` message without interrupting the receiver and returns `sessionId`, `name`, and `accepted`, not a reply. English locale preference uses `[From <name>] `; Chinese and unavailable locale preference use `〔来自 <name>〕`.

## Understand the implementation

The tools call the existing Host Session controller's create, model selection, prompt, rename, and list operations. Permission presets, directory resolution, title projection, and remembered model selection remain owned by their existing services. The list reads existing summaries and projections rather than rescanning full Session logs. Normal tool call/result records and the receiver's ordinary user message preserve the model-visible history. Generic tool cards display the canonical JSON results without Client changes.

## Further Exploration

- [Session services](../README.md) — persistence and projections.
- [Session controller](../../api/session-controller/README.md) — shared Host operations.
- [Tool catalog](../../../docs/tool-catalog.md#panedeskdsh-tool-session-ops) — generated schemas.

## Model Experience

### Tool schema and result

#### What the model sees

Four concise English tool descriptions summarize each operation; parameter descriptions retain argument details. Results are canonical JSON identities, Session rows, or delivery acceptance. A receiver sees the sender's current window name as a prefix on the delivered message.

#### Token effect

The four tool schemas add request tokens when available. Listing costs tokens proportional to the returned Session rows. Sending adds the prefixed text to the receiver's ordinary message history.

#### KV Cache effect

Tool availability changes the schema context. Calls append ordinary call/result history; delivery appends a receiver message without rewriting earlier messages.

## Known Limitations and Deferred Work

- Host locale preference may be unavailable when the browser has not explicitly saved a language; the sender prefix then uses Chinese.
- Listing and name resolution are snapshots, not delivery guarantees. Existing Host services own errors and lifecycle behavior; accepted delivery does not imply a completed reply.
- Session creation, optional model selection, permission selection, opening prompt, and rename are sequential existing operations, not a new atomic transaction.
