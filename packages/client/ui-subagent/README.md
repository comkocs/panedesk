---
description: "Subagent conversation catalog, continuation routing UI, and '@' reference source for the dsh web client."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-subagent

English | [中文](README.zh.md)

## Summary

Browse local subagent conversations and external tasks from the parent header. Local conversations show activity, token usage, and duration; continuable children accept follow-up prompts and support Stop. External tasks appear as non-navigable leaves; registered external tasks expose their status and Stop action in the map. Historical one-shot conversations open as read-only records. The ordinary sidebar omits subagent conversations, and the separate `@` source inserts a running child's label without granting continuation authority.

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

The session header keeps the current session title as the lineage breadcrumb; when the session's direct catalog has entries or a read has failed, the descendant-count trigger renders after the preset label in the header actions band, with no breadcrumb separator. An absent catalog, an empty loading catalog, or a successfully loaded empty catalog hides the count trigger. The trigger opens that direct catalog, reports its total and running counts, and loads nested catalogs only when their rows expand. Selecting a local child at any depth, the row's trailing arrow, the Agent map's Open conversation action, and the subagent tree's native-child details all open the child's exact `{parentSessionId, childSessionId, mode}` address as an independent floating panel. Reopening the same child raises its existing panel; the shared Sidebar controller owns initial placement and visible-session replacement. The main Session stays selected and retains its width; ordinary conversation navigation is unchanged.

This package registers the `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>` resource and builtin Sidebar tab type. The resource retains the child `SessionReference` directly from its address without refreshing the parent catalog, and releases the reference when the tab record closes. The tab renders the shared `conversation.content` Factory through `sidebar.chat.conversation`, fixes the local View to Chat, and omits the main Conversation header and width controls.

The composer's Agent map button sits between permissions and model selection. It opens a map with the current session alone in the top row, marked Main, and compact descendant cards below, including external tasks. Cards keep a fixed minimum height and a placeholder while titles arrive. Wheel zoom follows the pointer from 0.3× to 2×; hold and drag blank space to pan after moving 5px. Fit centers the whole graph at up to 1×, 100% restores actual size, and + / − zoom around the viewport center. Double-click blank space to fit. Fit may go below 0.3× for large graphs; new cards refit only until the view is manually adjusted or after Fit is selected again. Select a local card for its task preview and an action to open the conversation. When its latest recorded turn failed and it is no longer running, the preview shows the stored, redacted failure message, including any captured HTTP status and response details, in small secondary text that wraps. Failures without a recorded turn ending and external tasks have no diagnostic in this view. Background shell tasks appear at the lower left; selecting one shows its command and recent output. Agent cards show the latest reported request's context (uncached input plus cache reads and writes) and cumulative usage together on a dedicated line; missing request evidence stays unknown, including external registries that only report totals. Finished turns, including continuable children awaiting messages, have gray dots and no Stop button. Only running agents or agents waiting for their own children stay green; shell tasks remain green while running or stopping. Native models come from the tree's own-session transcript fold, and registered external cards prefer `实际模型` over `模型`; missing models stay unknown. The tree owns the five model-family colors, applied to the cards' left borders. The current session has a distinct background, both usage figures, and no Stop button. Active descendant cards have a red square Stop button and the detail pane has Stop beside Open conversation, including registered external nodes and shell tasks. Map parentage comes from the ledger tree; catalogs only supply labels and modes. Stop passes that exact tree node to the same action as the sidebar tree, interrupting the node and its active descendants child-first; external Stop terminates the recorded process trees and appends a terminal registry record; shell Stop calls `job.kill`. Failures name the affected card and distinguish ownership, connection or service failure, and ended or unavailable targets, with retry guidance. The transport uses the same error code for connection loss and internal service failures, so the map does not claim to distinguish those causes. No confirmation is shown. Settled stops display Stopped and gray dots. Close the panel with its close button or Escape.

### Browsing the tree

Hovering a trigger opens its catalog after 150ms; leaving both trigger and catalog closes it after 120ms. Clicking the descendant-count trigger pins its catalog until outside click or Escape from the trigger or tree. Breadcrumb-title clicks navigate to the corresponding conversation.

Rows display mode plus activity and an optional log-backed title; running uses the shared ongoing loader, an inactive child whose latest closed turn completed normally uses the shared success dot, and other inactive children use the shared idle dot. Every row reserves the same 14px status column, centering smaller dots so titles align with the loader state. The compact header trigger vertically centers its activity glyph and count with a 4px gap. The trailing column stacks total durable provider usage above active-turn duration. Keyboard navigation works with ArrowRight/ArrowLeft to expand and collapse branches and ArrowUp/ArrowDown, Home, End, and Escape to navigate or close the tree. An unlabeled one-shot row falls back to its session id. A row is a known leaf only after its own catalog loads empty.

Hover a local row for 500ms to open its task-flow card beside the catalog, preferring the right side and flipping left near the viewport edge. Moving into the card keeps it open; leaving both row and card dismisses it through the shared pointer grace. The card shows the task, activity (including a recorded failure), the last-used `provider · model · effort` (the effort appears only when the session declares one; a route that declares no efforts shows `effort not applicable`), duration, and tokens, plus up to 20 recent tool calls in execution order with single-line argument summaries and the loaded total. Calls update live and scroll inside the card; prompts are limited to one summary line and full replies are omitted. Missing or unreadable child history leaves only the heading. Row and trailing-arrow navigation remain unchanged.

### Continuing a conversation

A continuable child with a live parent keeps the ordinary input chrome: typing and Send stay available while the child runs because every follow-up joins the child's FIFO inbox, and an independent Stop routes through `subagents/interruptByParent`. A continuable child whose exact parent is unavailable and which is not running elects a read-only composer explaining the recovery path; while such a child still runs, the selector yields to the ordinary composer with input and Send disabled but its independent Stop usable.

### The `@` reference source

The `@` source remains deliberately separate and inert: candidates are zero-RPC running children from `ctx.sessions.list`, picking one inserts literal `@label ` text, and the codec projects `@label`. It has no command-adjudication hooks and does not resolve labels into continuation addresses.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [subagent runtime](../../subagent/subagent/README.md) owns continuation and interruption; the [conversation reference](../ui-conversation/README.md) documents composer behavior.

### Catalog derivation

The header lineage renderer reads `projectionsBySession` through the standard `useSessions` hook. The renderer selects `subagentCatalog` from each Session’s shared values for membership, disclosure, and counts; Activity prefers the unified UI status and falls back to Session summaries; summaries supply titles and usage. Expanding a row reads its target's projections, including ordinary cold history. A list row with `formatStatus: migration-required` displays “Migration required” before expansion and keeps its history-opening actions without descendant expansion or changing its subagent mode; a projection read requiring migration without a catalog supplies the same notice. Opening the Session supplies its catalog through history and control projections. Otherwise, an available catalog remains usable, including an explicit empty catalog. Live projection frames update every loaded level without menu subscriptions or repeated membership queries. Other rows remain expandable while their catalogs are absent, loading, or failed, and become known leaves after ready empty catalogs. External rows are always leaves and do not load child Sessions.

Task previews retain the existing `subagentchat` resource only while visible and bind its child reference to the standard `useChat` and `useProjection` seats; dismissal releases the resource without creating another data layer.

Opening a catalog dropdown does not request its root catalog. Child-catalog expansion and failed-read retries call `refreshProjection`; shared projection-value changes update the display automatically.

Breadcrumb addresses derive from the Provider-bound Session address, loaded parent catalogs, or already-listed subagent lineage, including never-selected ancestors.

### Duration, completion, and tokens

Each visible catalog level advances its own clock while it contains a running child; collapsing the level or closing the menu releases that clock. Token totals sum the four disjoint `tokenUsage` buckets. The `subagentTiming` projection sums completed-turn duration and records whether the latest closed turn ended with `completed`; opening another turn clears that completion until its own `turn/end`. Duration advances once per second only for an open turn on a running child and freezes after the child becomes inactive; an interrupted open turn is bounded by its same-cut `active.through`, never by newer session metadata.

### Composer election

One-shot children always elect a read-only composer. A continuable child elects one only when its exact parent is unavailable and the child is not running; otherwise the ordinary composer's Session routes prompts through `subagents/prompt`. This package never receives host context or calls a model-facing tool.

Unknown-mode catalog rows remain visible and clickable, using the child id when no label is available. Their composer is read-only until child history establishes a supported mode; a read failure is reported in the child conversation.

Lineage-menu highlights follow the [standard menu edge geometry](../../../docs/ui-radius.md#nested-hover); tree disclosure controls retain their separate left gutter.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the conversation surface, the host seam, and the design notes.

- [ui-conversation](../ui-conversation/README.md) — the chat surface hosting the header action and composer chain.
- [ui-input-trigger](../ui-input-trigger/README.md) — the suggestion machinery hosting the `@` source.
- [subagent](../../subagent/subagent/README.md) — the host-side capability seam behind continuable children.
- [historical Web subagent conversations](../../../.agents/notes/archived/feature/2026-07-27-web-subagent-conversations.md) — the catalog and composer specification.
- [Current-turn interrupt](../../subagent/subagent/README.md) — the independent Stop semantics.

-----

<a id="model-experience"></a>
## Model Experience

### Subagent label text in the user prompt

#### What the model sees

Only the `@` reference source affects model input: a picked candidate reaches the ordinary user message as literal `@label`, without a dedicated block or host-side resolution. Catalog browsing, child navigation, and persisted transcript viewing add no prompt section; accepted continuation content becomes a normal FIFO user message through the host subagent adapter.

#### Token effect

Conditional and append-only: the literal `@label` or a human follow-up adds tokens only to its new user message. Catalog and transcript operations add zero model tokens.

#### KV Cache effect

Append-only. This package never edits earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the catalog can show and what `@` references mean; they are current package constraints.

- **Non-completed inactive outcomes remain grouped** — the catalog distinguishes a latest normal completion from other inactive states, but does not distinguish failure, cancellation, refusal, token exhaustion, or a child with no closed turn; the UI exposes no Activation identity, the map additionally shows transcript-backed stopped states.
- **`@` references remain display-title text** — duplicate or renamed labels are ambiguous, so they intentionally do not acquire continuation semantics.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
