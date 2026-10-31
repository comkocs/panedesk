---
description: "Right-sidebar session tab opened from a session row, plus a per-message pin kept in the browser that never changes what the model sees."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-session-tab

English | [中文](README.zh.md)

## Summary

This package adds a session page type to the right sidebar and a pin on each finalized assistant message. The page is opened from a session row's menu and renders that session's transcript and composer alongside its pin list; choosing a pin scrolls only that sidebar transcript occurrence. A pin is a bookmark kept in the browser. It survives a restart and never changes what a model sees. The sidebar's shared visible-session budget reserves the main area and allows two visible session or subagent pages beside it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-workspace`, `ui-sidebar-right`, and `ui-conversation`. A session row's menu gains "Open in the right sidebar". The page type is not on the guide, so it does not appear before a session starts. The pin sits in the action row of a finalized assistant message. The session page lists that session's pins and loads older history when necessary before locating the chosen message.

### Failures

The menu reports when its proposed layout exceeds the shared visible-session budget. A browser that cannot keep storage shows that the pins cannot be saved. Invalid resource addresses and synchronous retention failures settle as visible opening failures. Pin jumps show loading, stop if history is exhausted or makes no progress, and offer a retry when the message cannot be located.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package registers the `session` tab type with `multiple: true` and no guide entry, contributes `open-in-right` (order 500) to `sidebar.workspaces.session.menu.item`, and contributes `pin` (order 20) to `conversation.chat.assistant-actions`. Pins are one document under `dsh.session-pins.v1`: `{ schemaVersion: 1, pins: [{ sessionId, messageId, pinnedAt }] }`. A `sessiontab` resource retains the target through `sessions.retain`, awaits opening, supplies its `SessionProvider`, and releases it when the resource closes. The shared `conversation.content` factory renders the transcript and composer. The jump searches only this page for `data-message-id`, calling the retained Session's `loadOlder()` until the row appears or paging stops. The Chat head detects progress without changing the pin format; leaving the occurrence or selecting another pin cancels further paging and scrolling, not shared in-flight history I/O. Pin writes publish through a framework-bound observable after storage succeeds; unsupported document versions are not overwritten. Opens prefer a new docked pane when space permits and use the sidebar's final-layout budget. Embedded composer phases distinguish awaiting-first-turn from prompt-attempted, following the shared conversation lifecycle.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-sidebar-right](../ui-sidebar-right/README.md) — the tab registry and the two-pane budget.
- [ui-workspace](../ui-workspace/README.md) — the session row menu.
- [ui-conversation](../ui-conversation/README.md) — the assistant action row.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as session tabs and browser-local bookmarks add no model-visible content or session events.

#### KV Cache effect

None. Opening a session tab and storing or removing a pin leave the model-visible history unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current session tab. They are current package constraints, not a backlog.

- **A pin needs a completed-turn action row** — history is paged automatically, but deleted or unrenderable messages cannot be located. A jump during another history load asks for a retry rather than starting competing pagination.
- **Pins stay in this browser** — the document is local storage. Another browser, or storage that was cleared, does not have them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
