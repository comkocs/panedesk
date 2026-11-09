---
description: "Choose an Agent’s tools, prompt sections and skills through declarative presets. One process can run several compositions. Failed definitions remain visible, while existing Agents retain the composition they already use."
kind: "package-reference"
---

# @panedesk/dsh-agent-preset-registry

English | [中文](README.zh.md)

## Summary

Choose an Agent’s tools, prompt sections and skills through declarative presets. One process can run several compositions. Failed definitions remain visible, while existing Agents retain the composition they already use.

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

### Minimal configuration

```yaml
- id: agent-preset-registry
  name: '@panedesk/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@panedesk/dsh-agent-preset'
  config:
    id: standard
    plugins: []
```

| Field | Default | Meaning |
|---|---|---|
| `default` | required | Preset ID used when none is requested |

Web declarations come from the `dsh-web-app` bundle. The registry also reads `~/.claude/agents/*.md` and workspace `.claude/agents/*.md` once at startup; project definitions override user definitions of the same name. Import retains instructions, mapped tool restrictions, and model/effort preferences without resolving a provider. The instruction plugin uses the `@panedesk/dsh-agent-preset-registry/claude-agent-instructions` subpath: source launches resolve it through the workspace alias, while installations load the published `lib/types/claude-agent-instructions.js` export. Delegation resolves model preferences from the live catalog, falls back to the parent route when absent, and honors explicit model overrides. Missing providers at startup do not mark these types broken. The `selectedDefault` volatile field overrides the deployment default for new sessions.

The remote roster marks imported Claude agent types with `importedAgent`; the top-level mode picker hides those rows. Import, resolution, and delegation by preset ID still use the complete registry.

Claude Code tools map to Panedesk capabilities: `Read` → `read`, `Write` → `write`, `Edit` / `MultiEdit` → `edit`, `Grep` → `grep`, `Glob` → `glob`, `Bash` → `bash` and `pwsh` where installed, `WebFetch` → `web_fetch`, `WebSearch` → `web_search`, `TodoWrite` → `todo_write`, `Skill` → `skill`, `AskUserQuestion` → `ask_user_question`, and `Agent` → delegation tools, including renamed instances. `Agent(x, y)` retains the parenthesized list and requires an explicit `agent_preset` from that list when delegating; plain `Agent` leaves types unrestricted. The same execution guard applies to descendants. Only mapped capabilities are restricted: auxiliary tools such as `working_directory`, the `run_code` transport, and MCP tools remain available. Unknown names produce one informational log line per definition without preventing import.

The registry writes no declarations. The `read` Remote renders one declaration’s child list back as entry-list YAML (`!!js` conditions included) so a client can show what a preset composes; nothing accepts YAML back. A new preset or an override of a shipped one is a bundle patch: an `insert` of a `@panedesk/dsh-agent-preset` row, or a patch keyed by that row’s id, installed into the profile with `plugin_manager`; Creator mode authors such bundles in conversation.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each declaration eagerly creates a registry-owned scope and an in-memory Loader tree. Updating or removing a declaration retires its previous revision. Agents, children and temporary historical reads retain references; releasing the final reference disposes the retired tree. Plugin registrations inherit the preset scope, and the Agent scope’s parent link controls visibility. The Host continues to share the Agent loop.

A preset service provider and its consumers must share one `cordis:group` isolation realm. Entry-local isolation does not propagate through the Agent registration scope: ordinary Context lookup outside the group, including `agent.ctx`, still selects the Host realm. `agentPresets.serviceFor()` explicitly inspects the retained composition; it does not change ordinary service lookup.

Activation auditing checks imports, missing services and globally leaked services. Import failures, activation failures and leaks reject the mount. A row waiting for a Host service stays mounted, and every read and binding re-audits it after the Host Loader tree settles, so startup order does not decide the outcome. Failure prevents new bindings to that definition. Session logs retain the preset ID and blank-session selections; recovery after restart uses the current definition of that ID and rejects a missing definition. `select` leaves a blank Session that records the requested preset and already runs its current revision unchanged, without another selection record or `tools/change`.

`inspectCompositions()` reads all revisions retained by this registry; passing an Agent context selects its exact revision, or returns an empty list when it has no binding here. Each `AgentPresetInspection` contains a preset ID, detached active-module references with their resolution bases, and leaked-service names. Inspectors query the runtime service rather than a module-local mount table; the results contain no Loader trees or fibers. [composition-inventory.ts](src/composition-inventory.ts) defines these records.

| File | Responsibility |
|---|---|
| [index.ts](src/index.ts) | Registration, revisions and Agent bindings |
| [mount.ts](src/mount.ts) | Scoped plugin trees and activation auditing |

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Scope](../../core/scope/README.md) — Registration isolation.
- [Agent](../../core/agent/README.md) — Session runtime.
- [Cordis](../../../docs/cordis-primer.md) — Plugin configuration and lifecycle.

<a id="model-experience"></a>
## Model Experience

### Preset selection

#### What the model sees

Nothing directly: the selected preset’s `plugins` own the model-visible tools and prompt sections.

#### Token effect

None from this package; each mounted `plugins` row declares its own tools and sections.

#### KV Cache effect

Existing Agents retain their plugins and prompts. New Agents build their prefixes from the current definition.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Presets are not security sandboxes: YAML and plugins can execute Host code. A user override replaces the complete child list and does not automatically merge future changes to the builtin list. Old revision implementations are not retained across process restarts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
