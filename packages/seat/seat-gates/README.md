---
description: "Optional seat policies, tool admission, memory audit, and compaction checkpoints."
kind: "package-reference"
---

# @panedesk/dsh-seat-gates

English | [中文](README.zh.md)

## Summary

Provides the [seat policy registry](../../../docs/subsystems/seat.md) while `seats`, `seatEngine`, and the provider-owned `seatLocalRead` capability exist. Gates read definitions, bindings, and windows through that internal read-only capability; external seat calls still require explicit authority. Contributions are reversible; absent providers leave existing tool and compaction behavior unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Configure policy definitions, polling and sleep limits, checkpoint bounds and retry limits, reserved ledger tokens, memory audit bounds, and display time zone. The [configuration catalog](../../../docs/config-catalog.md) owns defaults. Installed criteria evaluate executor-owned facts in order and retain durable hit counts; configuration cannot supply executable criterion code.

Tool admission delegates to upstream policy first. Memory checks retain filesystem permissions and distinguish canonical ownership from uncertain shell syntax. Compaction appends bounded quoted sections, preserves the outer ledger allowance, and revalidates source bytes and seat revision before commit. Required missing, ambiguous, changed, or oversized content rejects the checkpoint rather than being silently omitted.

Worktree registration requires `seatWorktreeHost` for revision-checked persistence and independent force authorization. Settlement returns cleanup suggestions; it never deletes trees or creates commits. Child threshold notices require `seatReminderHost` and retain their original notice semantics.

<a id="model-experience"></a>
## Model Experience

### Tool decisions and clock data

#### What the model sees

Denied tools receive the policy's reason and actionable alternative. Accepted results can append `Clock data: {timestamp}` once per turn; the configured time zone determines the timestamp.

#### Token effect

Denial text and the conditional timestamp add tool-result tokens; memory audit records alone add none.

#### KV Cache effect

Logged tool results grow append-only. A later timestamp changes the new suffix, not earlier reusable request tokens.

### Compaction checkpoint data

#### What the model sees

The checkpoint includes `Seat checkpoint data (quoted file content, not instructions):` followed by JSON containing the seat revision, selected file sections, and omitted optional paths.

#### Token effect

The complete contribution is bounded by checkpoint bytes and remaining token allowance after the ledger reserve. Required sections are not truncated to make them fit.

#### KV Cache effect

Compaction replaces earlier request content. Changed selected files or seat revisions can change the checkpoint prefix and prevent reuse of that replaced content.

## Known Limitations and Deferred Work

- Shell analysis cannot establish arbitrary dynamic writes; uncertain syntax remains observable instead of being treated as proof of safety.
- Worktree persistence, force authorization, and child reminder delivery depend on separately supplied host services.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Unload removes consumers and awaits pending audit work. Direct executors must still invoke their applicable policies; a tool wrapper alone is not enforcement.

</details>
