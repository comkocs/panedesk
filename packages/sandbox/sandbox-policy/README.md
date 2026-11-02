---
description: "The shared per-call sandbox policy resolver and current model context for users and maintainers composing, configuring, or debugging file-effect policy across enforcing capabilities."
kind: "package-reference"
---

# @panedesk/dsh-sandbox-policy

English | [中文](README.zh.md)

## Summary

Use this package to apply one file-effect policy to every confined bash, filesystem, and terminal call. Deployments choose a default mode and fallback workspace root, while each session can switch modes independently. Session choices survive restart, and all enforcing capabilities use the same mode and workspace for a call. Before each model request, the model receives the effective policy and workspace without an inventory of mounted capabilities.

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

Mount this package in any composition where sandbox-enforcing capabilities run: it owns the deployment default and the per-session overrides those capabilities consume, and it contributes the current policy to the model's runtime-context snapshot.

### When to choose it

Choose it for every composition with confined capabilities (bash, filesystem, terminal) so one policy home keeps them from drifting into different modes or workspace roots. Skip it only when nothing enforces sandbox policy — with no consumers, the resolved policy has no effect.

### Minimal configuration

Without an explicit configured mode or `PANEDESK_PERMISSION_MODE`, Windows defaults to `read-only` and Linux/macOS default to `workspace-write`. Explicit deployment and session choices take precedence over these platform defaults.

```yaml
- name: '@panedesk/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: /absolute/path/to/workspace
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | Windows: `read-only`; Linux/macOS: `workspace-write` | Explicit configuration or `PANEDESK_PERMISSION_MODE` overrides the platform default; validated at load |
| `workspaceRoot` | `process.cwd()` | Absolute fallback root for agentless calls or sessions without a cwd; relative values fail at load. Normal agent calls use the session's immutable cwd |

The generated [configuration catalog](../../../docs/config-catalog.md#panedeskdsh-sandbox-policy) is the exhaustive source for every accepted field and its JSDoc.

### Switching a session's mode

A session's mode can be switched at runtime through a UI policy control or an explicit switch; the switch is recorded in the session log and takes effect on the session's next confined call. The switch survives restart through replay, and each session keeps its own mode — two sessions never see each other's state. A switched session keeps its immutable workspace cwd as the writable boundary.

<a id="windows-workspace-records"></a>
### Windows workspace records

Under the implicit Windows default, a valid authorization in the product home's `windows-workspace-write` directory enables `workspace-write` for that canonical directory. Records contain the directory, ISO authorization time, and a source: settings write `settings-preauthorization`, while an accepted first-workspace-write approval writes `first-confirmation`. `requestWrite()` asks only under the implicit Windows default without a record or explicit session mode; acceptance persists consent before materializing the native grant. Rejection, cancellation, unavailable answerers, and the approval deadline leave access read-only. `never` does not dispatch a prompt. Record-derived access is resolved on each call rather than stored as a session override, so revocation also affects the consenting session. Reading or writing a record alone does not modify ACLs. Explicit deployment, session, and approved call modes remain authoritative. Record writers share a per-file cross-process lock. Revocation first persists a `.revoking` deny marker, then removes the native capability, record, and marker in order. An interrupted revocation blocks record-based writes and reauthorization until a retry completes; an ACL failure retains the inventory record for retry. `pendingRevocations()` validates and lists interrupted markers even without a consent record. Revoking an exact recorded directory that no longer exists removes its record and marker without a native ACL call, after checking the nearest existing ancestor. A replacement symlink, non-directory, or inaccessible path fails closed and retains consent for recovery; the check does not protect against concurrent filesystem replacement. `withAuthorization()` revalidates consent under the same lock immediately before record-derived native ACL materialization, including cached policies. Its callback must not recursively authorize or revoke the same directory. The lock does not cover process lifetime or subsequent file operations; revocation does not terminate running processes or invalidate already-open handles. These records describe local Windows directories, not remote execution paths.

`writeDenialHint(mode)` supplies owner preauthorization guidance for settled read-only denials under the implicit Windows default. Filesystem and command tools retain it in their ordinary results; other platforms, explicit deployment modes, and wider settled modes receive no replacement hint.

### Protected host inputs

`resolve()` collects `protectedPaths` from the running profile, home patch and authorization records, bundle manifests and patches read by boot, command-line overlays, imported plugin directories, Host HMR roots and active `watchConfig()` registrations, and Client artifact directories. It does not inspect unrelated workspaces for plugin-like files. Confined filesystem writes reject overlapping paths; local process providers exclude protected inputs or refuse a workspace grant that includes them. Windows record creation and locked ACL materialization reject overlapping roots. `danger-full-access` retains the host user's write authority; plugin management still requires separate owner consent.

Protection is checked at operation admission. A changed set prevents reuse of a retained Node kernel or terminal on its next call, but does not terminate already-running processes or invalidate open handles. Host paths are local filesystem identities, not a declaration of remote SSH paths.

### Failures and recovery

An invalid configured mode is rejected when the plugin loads, so a typo fails loud instead of silently changing policy. A session without a cwd, and agentless calls, fall back to the configured workspace root; a call with an approved explicit mode uses that mode for exactly that call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains policy resolution, the per-session store, and the model-visible contribution; the observable behavior is fully covered in [Use this package](#use-this-package).

### Resolution precedence

`resolve({ session, mode })` returns one complete per-call policy: an approved explicit mode outranks the session's last `sandbox/mode` event, which outranks the effective deployment default. Only the implicit Windows default consults the home-level workspace authorization, after native canonicalization; explicit deployment choices do not. The session's immutable `cwd` supplies the workspace root; otherwise the configured fallback applies. The returned root preserves its execution-world spelling. Enforcing providers canonicalize it on their own filesystem. The supported SSH composition requires POSIX hosts at both ends and does not consult Windows records.

### The per-session store

A runtime session switch is one log-only `sandbox/mode` event on the session it applies to. `effective = approved call mode ?? fold(events) ?? authorized Windows workspace/default`, so a session override survives restart by replay. Session overrides are independent; home-level Windows workspace authorizations are intentionally shared between sessions using that directory. Workspace identity needs no event: the immutable `SessionHeader.cwd` recorded at creation is the root for every call in that session. The event stays log-only; before each request, the owner contributes the current fact to the full runtime-context snapshot, and the agent loop logs that snapshot as a sourced `user/message`.

### Model-visible text

The `sandbox:policy` contribution states the mode's capability-neutral file-effect contract and the recorded session workspace under `workspace-write`. It does not enumerate mounted capabilities; tool plugins retain operation-specific denial and escalation guidance, approval policy contributes separately to the same snapshot, and plan guidance remains `dsh-plan-mode`'s system section.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SandboxPolicyService`, `Config` schema, policy resolution and context contribution |
| [`src/session-mode.ts`](src/session-mode.ts) | The `sandbox/mode` event, its fold, and the write path |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Start with the subsystem reference for the shared vocabulary, then the seam contract and the cross-family decision.

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, and enforcement semantics.
- [Sandbox seam package](../sandbox/README.md) — the confinement contract every enforcing capability implements.
- [historical Cross-family file sandbox decision](../../../.agents/notes/archived/feature/2026-07-14-cross-family-fs-sandbox.md) — why one shared policy home exists.

-----

<a id="model-experience"></a>
## Model Experience

### Current file sandbox policy

#### What the model sees

One `sandbox:policy` contribution in the current runtime-context snapshot for every agent session. It does not enumerate mounted capabilities. Tool plugins retain operation and escalation guidance, approval policy contributes separately to the same snapshot, and plan guidance remains `dsh-plan-mode`'s system section.

##### Read-only

```markdown
Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.
```

##### Workspace-write

```markdown
Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "<workspace root>". Some platform temporary areas may also be writable.
```

##### Danger-full-access

```markdown
Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.
```

#### Token effect

One concise durable context message on the first request and each effective policy change; unchanged requests add nothing. `workspace-write` carries only the recorded session workspace path; platform-specific temporary paths are summarized without adding host-dependent bytes.

#### KV Cache effect

The stable system prompt remains byte-identical across mode changes. A changed full context snapshot is appended after retained history, preserving the prior cached prefix; subsequent unchanged requests reuse that retained snapshot.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the policy surface this package provides. They are current package constraints, not a general sandbox comparison or a task backlog.

- **One primary workspace root per session** — policy resolves `SessionHeader.cwd`; extra writable roots are not part of `SandboxExecutionPolicy`.
- **File-effect modes only** — `SandboxMode` governs file effects; network and process policy are outside its vocabulary, so no knob here restricts them.
- **Temporary areas are deliberately summarized** — enforcing backends grant different platform temporary areas, which are selected after policy resolution and therefore cannot be enumerated truthfully in the current context.

Policy-context replacements must be counter-tested on denied-then-escalatable tasks to verify that the model still attempts the initial tool call. The [historical five-of-twelve zero-tool-call measurement](../../../.agents/notes/archived/feature/2026-07-06-sandbox.md) records the failure this check prevents.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
