---
description: "Model-facing subagent delegation tool for users and maintainers configuring, composing, or debugging delegation over a subagent provider."
kind: "package-reference"
---

# @panedesk/dsh-tool-subagent

English | [中文](README.zh.md)

## Summary

Use this package to give an agent a named tool that delegates work to a configured backend. An admitted call starts a managed activation and returns a child id; a queued call returns an admission ticket instead. The runtime owns completion notices and cleanup. Local children support messages and restoration, while external backends execute one task and return their final answer through the completion notice. Supported backends can expose approved child LLM routes. Each instance can select a child preset and depth limit.

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

The optional `cwd` argument selects the child's initial working directory. Relative paths resolve against the caller's current directory; omission inherits it. Existing children retain their own directories when the caller changes directory.

Mount one instance per delegation target, each with a distinct `toolName`. The tool exists exactly while its provider does, so sibling load order and provider reloads never strand it.

### Minimal configuration

Load the subagent service, an in-process or remote backend, and this tool; then name the provider. This composition exposes a `subagent` tool that delegates to the `spawn` backend:

```yaml
- name: '@panedesk/dsh-subagent'
- name: '@panedesk/dsh-subagent-spawn-in-process'
- name: '@panedesk/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | required | Provider name on `ctx.subagents` (e.g. `spawn`, `fork`, `acp`) |
| `toolName` | `subagent` | Model-facing tool name; distinct for every loaded instance |
| `modelSelectionSettings` | ignored | Retired compatibility field; every Session can select configured models |
| `agentOptions` | — | Configured child `provider`, `model`, adapter-owned `reasoningEffort`, and positive `maxTokens` defaults; requires provider `agentOptions` support and overlays any provider-owned route defaults |
| `agentPreset` | — | Default independent child preset id; requires in-process spawn |
| `allowedAgentPresets` | ignored | Retired compatibility field; `agent_preset` offers every usable registered preset |
| `maxDepth` | Host setting (`1`) | Absolute delegation-depth cap (`0` forbids delegation); `'provider-managed'` sends no cap to an out-of-process provider |

The generated [configuration catalog](../../../docs/config-catalog.md#panedeskdsh-tool-subagent) is the exhaustive source for every accepted field and its JSDoc.

### Managed delegation

An admitted call returns `started subagent <childId>` after the runtime accepts the child. A queued call instead returns its admission ticket without creating a child or waiting for capacity. Root overflow tickets include their queue position and tell the caller to continue other work or close an idle child to free capacity; provider-owned tickets without a position retain their provider's wait guidance. Neither result waits for the child's result. The activation owns the work independently of the completed tool call; the runtime sends a completion notice and releases execution resources.

Every backend’s completion notice carries its final answer. Local Spawn and Fork children can also send messages, accept more work through `send_message` while active, or resume after settling. Codex, Claude Code, ACP, and DSH SDK backends do not accept follow-up messages.

`maxDepth` caps recursion (`0` forbids delegation); omission reads the current Host `subagent.maxDepth` setting, initially `1`, at each delegation. A numeric depth requires a provider with the `depthLimit` capability; `'provider-managed'` leaves the budget to an out-of-process provider. The tool stays visible at the cap; each attempted start checks the calling agent's current depth and rejects with an errored result.

<a id="selecting-a-child-preset"></a>
### Selecting a child preset

Set `agentPreset` to choose an independent child preset by default. The optional `agent_preset` argument offers all usable registered presets, including imported `.claude/agents` types, without an allowlist switch. Independent preset composition requires in-process spawn; fork and external backends reject explicit preset selection.

The configured default must name a usable preset. Preset descriptions are read during Agent initialization, independently of backend registration order, and choices are validated again at delegation. Omission uses the configured default or inherits the parent composition. Explicit selection mounts the current revision. Imported model preferences resolve at dispatch; missing model names inherit the parent route and the start result reports the actual provider/model. An explicit `model` overrides the imported preference.

Compose persona and tools in the [preset plugin list](../../preset/agent-preset-registry/README.md). Tool configuration containing `persona` or `toolFilter` fails at load with a migration error. Local children use the shared [preset restoration rules](../subagent/README.md#restoring-child-composition).

### Selecting a child LLM

Every new and restored Session exposes optional `model`, `provider`, and `reasoning_effort`, plus `list_subagent_models`. Neither settings nor historical Session policy gates selection. Discovery lists every configured provider/model route, or filters by provider and inspects a model’s reasoning efforts. Backends without `agentOptions` reject a selected route at dispatch.

A model name is matched exactly against `llm.listModels` for all registered providers. One match selects that provider; multiple matches fail with provider/model candidates, and no match fails with the available models. Supply `provider` to disambiguate. Provider-only requests fail. Explicit selection overlays configured and provider defaults; a changed route without an effort clears route-owned reasoning defaults. Omitted values otherwise inherit compatible parent values. The existing LLM adapter validates and sends the selected route using its configured protocol.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tool mirrors provider lifecycle and settles runs; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

One instance follows its backend’s registration lifetime. Direct Agent setup installs immediately; standing preset compositions install in each matching Agent scope and validate live preset choices, without reading a Session model-selection policy. Discovery is shared where already visible. Depth and configured child options retain backend capability checks.

### Activation ownership

The tool calls `ctx.subagents.startActivation()` with parent delivery selected. The runtime owns startup cancellation, execution, outcome reporting, and cleanup. A startup failure is an errored tool result; failures after publication arrive through the completion notice, with diagnostics and partial output preserved by the runtime.

### Result acknowledgement

The canonical tool result is `{ kind: 'activation', subagentId }`. It contains no execution Promise or final output; programmatic consumers that need to await results use the subagent service directly.

### Context-sensitive wording

The tool's description derives from `provider.inheritsParentContext`: a fresh child gets "it does not see this conversation" wording, a forked child gets "it does not see the current in-flight turn" wording, so the model never restates or omits context that does not exist.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Tool registration, provider lifecycle mirroring, activation requests |
| [`src/preset-selection.ts`](src/preset-selection.ts) | Configured preset validation, model allowlist, and description guidance |
| [`src/model-selection.ts`](src/model-selection.ts) | Request/config merge and live LLM route preflight |
| [`src/model-selection-settings.ts`](src/model-selection-settings.ts) | Retired settings service retained for existing deployment configuration |
| [`src/model-selection-state.ts`](src/model-selection-state.ts) | Historical Session policy projection, retained for reading old logs but not used for selection |
| [`src/list-models.ts`](src/list-models.ts) | `list_subagent_models` runtime discovery tool |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the tool's runtime behavior to the seam it delegates over and the adjacent child tools.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — providers, activations, results, and continuation.
- [dsh-tool-subagent-control](../tool-subagent-control/README.md) — messaging, interrupt, and listing tools for continuable children.
- [Generated tool catalog](../../../docs/tool-catalog.md#panedeskdsh-tool-subagent) — the default schema and backend-specific wording.
- [Generated configuration catalog](../../../docs/config-catalog.md#panedeskdsh-tool-subagent) — every accepted config field.
- [Historical model-selected subagent routes](../../../.agents/notes/archived/feature/2026-08-18-model-selected-subagent-routes.md) — selection policy, inheritance, discovery, and the fork restriction.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The tool always exposes `agent_preset`, `model`, `provider`, and `reasoning_effort`, in new and restored Sessions alike. Usable preset ids and descriptions are advertised when the registry is available. Context inheritance and continuation support determine task and follow-up descriptions. A tool restriction removes the schema and its guidance.

#### Token effect

Fixed schema cost per parent request includes three model-selection parameters and one preset parameter with available preset descriptions. Each tool instance adds one schema and one short system-prompt section.

#### KV Cache effect

Prefix-stable while provider instances and their configuration are unchanged. Adapter catalog changes do not alter the definition; a child route override may prevent a fork child from reusing the inherited parent prefix.

### Model selection and discovery

#### What the model sees

`list_subagent_models` lists the full live configured catalog. Optional provider/model arguments narrow discovery or inspect reasoning efforts. Explicit model selection requires a unique configured route; missing or ambiguous names produce actionable errors. The optional `ctx.llm` service must be available for model lookup.

#### Token effect

One discovery schema is shared by visible delegation compositions. Catalog contents enter the transcript only when requested.

#### KV Cache effect

The schema is prefix-stable across adapter registration and catalog changes. Each discovery result is appended after the reusable prefix.

### System prompt

#### What the model sees

Visible delegation tools share one guidance paragraph, listing tools in name order and instructing the model to start independent delegations together and keep working while they run, and to end its turn instead of sleeping or polling when only waiting for their results remains. Hidden or unavailable tools are omitted; no guidance appears when none are visible. With both `subagent` and `subagent_fork` visible, the text is:

##### Tool-guidance section

```markdown
Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run.
```

#### Token effect

At most one short delegation paragraph per parent request, listing the tool names visible to that request.

#### KV Cache effect

Prefix-stable while the visible tool names are unchanged; adding or removing a visible tool changes the paragraph.

### Runtime depth context

#### What the model sees

When the calling agent reaches or exceeds a visible tool's effective numeric depth cap, an optional runtime-context snapshot tells it to do the work directly. The cap is resolved again at each request, including after settings changes or session resume. Hidden tools and `provider-managed` limits contribute no depth text. For a child at depth one with a cap of one:

##### Depth-limit notice

```markdown
Delegation depth for `subagent`: current 1, maximum 1, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly.
```

#### Token effect

One short contribution per capped tool joins the user-role runtime-context snapshot. Unchanged snapshots are not appended again; agents below the cap receive no additional text. `includeRuntimeContext: false` suppresses this notice without changing runtime depth enforcement.

#### KV Cache effect

Depth changes do not alter the system prompt or tool schemas. Updated runtime context appends after existing history; the provider still enforces the cap if the model attempts delegation.

### Start result

#### What the model sees

The call retains the task description and prompt. Local startup returns `started subagent <childId>; model <provider>/<model>` after its first request establishes the actual route; startup rejection returns an error. Child execution details are delivered separately.

#### Token effect

The prompt and acknowledgement remain in parent history until compaction; child working context remains in the child.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Completion delivery

#### What the model sees

Answer delivery follows the managed delegation rules above. The returned child id identifies subsequent control and catalog operations; only backends with continuation support accept follow-up messages.

#### Token effect

Messages and completion notices append to parent history independently of the start acknowledgement. The tool result itself contains no final output.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what this tool does not return or enforce; they are current package constraints.

- **This tool does not wait for results** — use the completion notice or child messages. Programmatic result waiting belongs to the subagent service.
- **Fork route changes can prevent prefix reuse** — selection is available, but another model/provider may recompute the inherited conversation.
- **Backend capabilities still apply** — independent presets require spawn; model overrides require `agentOptions`. Explicit runtime execution policies remain enforced for controlled presets.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
