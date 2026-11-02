---
description: "Channel-neutral one-shot approval seam for users and maintainers composing answerers, setting policy, or debugging fail-closed permission decisions."
kind: "package-reference"
---

# @panedesk/dsh-user-approval

English | [中文](README.zh.md)

## Summary

Require a decision before a sensitive tool action proceeds: `ask` consults human or machine answerers, while `never` rejects without prompting. Missing or failed answerers return `unavailable`, failing closed. Ordinary approval covers one action; workspace-purpose approval requests persistent Windows directory access, stored by the sandbox policy consumer. Requests and outcomes enter the session audit log. The model sees tool outcomes and current policy, not the human permission UI or audit events.

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

Compose this service when sensitive tool actions should pause for a human or machine decision instead of running unconditionally. The tools pipeline and the sandboxed bash tool route their `ask` decisions through this seam and fail closed when it is absent, so interactive deployments mount it with at least one answerer.

### Composing answerers

Ordinary answerers are `approval/request` waterfall listeners: return an outcome for an owned agent, or call `next()` to delegate. Agent-scoped listeners receive only that agent's requests; sibling order is not policy priority. Workspace-purpose requests and requests with `ownerOnly: true` bypass this Host waterfall and go directly through Gateway to authenticated owner answering streams. They return `unavailable` without such a stream; a Host listener's return cannot approve them. The service itself never prompts a human.

### Setting the policy

The effective policy is the one set for the session, falling back to the configured default. `ask` (the default) delegates to the composed answerers; `never` rejects every request deterministically before interactive dispatch — the strict headless stance for CI and unattended runs.

```yaml
- name: '@panedesk/dsh-user-approval'
  config:
    policy: ask
```

| Field | Default | Meaning |
|---|---|---|
| `policy` | `ask` | Default for sessions without an `approval/policy` override |
| `workspaceWriteTimeoutMs` | `60_000` | Maximum wait for workspace consent; expiry cancels the request |

The generated [configuration catalog](../../../docs/config-catalog.md#panedeskdsh-user-approval) is the exhaustive source for every accepted field and its JSDoc. `setPolicy(agent, policy)` switches a live agent and queues a "changed by the user" message for its next model step; `setApprovalPolicy(session, policy)` is the direct durable write path used by session initialization.

### Requesting a decision

`request(req)` names the agent, tool, optional call id and reason, and an abort signal. Optional `purpose` identifies workspace consent and is retained in the audit event; its `allowed-once` outcome consents to that named purpose, not a generic permanent grant. Optional `displayReason` supplies localized presentation text without changing the logged reason. It requires an open turn: an idle or between-turn caller throws before auditing anything. Aborting withdraws the question — the request settles `cancelled` and a late answer is discarded. A failure that prevents either audit append from committing rejects instead of returning an unlogged decision.

`requestProtectedInput(agent, purpose)` accepts a path and its previous and candidate digests between turns. It uses only authenticated owner transport and queues passive, durable inbox notices without waking the model. `never` retains the blocked-input notice without prompting; other outcomes append a decision notice. The wait uses `workspaceWriteTimeoutMs`; only `allowed-once` confirms that candidate. For a mounted profile, owner transport readiness and new root agents schedule a serialized review of retained input records. An available HMR transaction applies approved inputs; without HMR, the passive notice asks the owner to restart. Direct recomposition refusals schedule the same review without blocking on a prompt. Unattended sessions retain refusal notices and never prompt. The same exact-candidate decision governs newly added Client chunks and whole-package replacements; refusal preserves the published Client generation.

Before returning an authenticated workspace-write allowance, a mounted profile captures its registered protected inputs in persistent owner state outside the writable root. Capture failure settles the request as `unavailable` and records that outcome instead of granting write access. Protected-input confirmation is separate and never creates a general workspace grant. [Workspace consent](../../sandbox/sandbox-policy/README.md#windows-workspace-records) enables ordinary workspace writes, not writes to protected inputs.

### What the model and user see

For tool requests, the model sees the consumer's eventual outcome — allowed, rejected, cancelled, or unavailable — plus the current policy; audit events and the human permission UI are not model context. Protected-input notices remain in the inbox until a later model step consumes them. A `never` switch is announced to the model by a sourced user message, and both policies contribute their complete current meaning to the snapshot.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains dispatch, policy enforcement, and the audit path.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `ApprovalService`: request dispatch, policy fold and write path, runtime-context contribution |
| [`src/types.ts`](src/types.ts) | `ApprovalRequestId` brand and outcome types |

### Dispatch

`decide()` races the answerer waterfall against the request signal and contains every answerer failure: a throwing listener fails the question closed to `unavailable`, and a rogue non-vocabulary return is normalized to `unavailable`. The `never` policy is enforced inside the service before waterfall dispatch, so a listener registered later with `prepend` cannot bypass the deterministic rejection. `request()` must be turn-enclosed because the turn is the durable log's commit/replay boundary — a bare event between turns is indistinguishable from a crash tail.

### Policy and the runtime-context snapshot

The system-prompt contribution `approval:policy` states the complete current meaning of the effective policy — `ask` with its fail-closed consequence, or `never` with its non-escalation consequence — after retained history, so switching policy appends a new full snapshot instead of rewriting the stable request header. `setPolicy()` also injects a sourced user message announcing the change for the next step.

### Audit

`request()` appends `approval/asked` with the request identity and tool, then `approval/decided` with the closed outcome; the exact appended fields live in [`src/index.ts`](src/index.ts). Both are log-only.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the approval vocabulary to the consumers and the design rationale.

- [Approval subsystem reference](../../../docs/subsystems/approval.md) — the shared request/outcome vocabulary and the `ctx.approval` Cordis surface.
- [Approval seam Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-approval-seam.md) — design rationale for the seam.
- [Sandbox reference](../../shell/tool-bash/README.md) — how the sandboxed bash tool consumes approvals for escalated retries.
- [Interaction group map](../README.md) — adjacent permission preset and question packages.

-----

<a id="model-experience"></a>
## Model Experience

### Current approval policy context

#### What the model sees

The first request and each effective policy change append a full runtime-context snapshot after retained history. Under `ask`, the approval contribution states that configured answerers may be consulted and absence fails closed. Under `never`, it states the deterministic rejection and non-escalation consequence. Unchanged requests retain the earlier snapshot without adding another message.

##### Ask-policy contribution

```markdown
Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.
```

##### Never-policy contribution

```markdown
Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).
```

#### Token effect

One concise context message on the first request and on an effective change; unchanged requests add no duplicate policy tokens.

#### KV Cache effect

Append-only after retained history. An `ask`/`never` switch preserves the stable system and conversation prefix instead of rewriting the first wire message.

### Tool outcome

#### What the model sees

`approval/asked` and `approval/decided` are log-only. The model sees only the asking consumer's eventual allowed, rejected, cancelled, or unavailable tool outcome; the human permission UI is not context.

#### Token effect

Zero duplicate audit tokens. A rejection may replace a normal tool result with a small retained error, while an allowance leaves the consumer's ordinary result. Passive protected-input notices add their text when a later model step consumes the inbox.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam is a poor fit or needs special composition care. They are current package constraints, not a general permission comparison.

- **`request()` requires an open turn** — an idle or between-turn caller throws before auditing. `requestProtectedInput()` instead retains passive inbox notices; those notices are not a persistent input authorization store.
- **No generic grant store** — `allowed-once` consents to the request's declared purpose; without a purpose it covers one action. Workspace persistence and revocation belong to the [sandbox policy consumer](../../sandbox/sandbox-policy/README.md#windows-workspace-records), not this service. Session policy remains `ask` / `never`.
- **The request carries no tool arguments** — an answerer sees the tool name, reason, and optional call id; the ACP machine channel requires a call id and delegates requests without one.
- **No built-in answerer** — headless or incompletely composed deployments resolve `unavailable` and fail closed; the service itself never prompts a human.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
