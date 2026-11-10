---
description: "Workspace verification switches enforced before tool execution."
kind: "package-reference"
---

# @panedesk/dsh-verification-policy

English | [中文](README.zh.md)

## Summary

The Web/Desktop composition installs `verificationPolicy`. It consumes the activity service's classification, task timing and refusal text rather than classifying commands independently. Enabled defaults to true; disabling it leaves activity accounting running without decisions or client timeouts.

## Use this package

Settings are workspace-keyed records in the `workspace-verification` storage-domain, table `settings`, with `version: 1`. `src/storage.ts` owns all persistence reads and writes so a later database migration replaces one adapter. Nothing is written into the project or exposed through `panedesk_settings`.

Default allows one full test run across a root user's turn and all its child runs, denies mutation tests and allows other categories. Unlimited allows all categories without limits. Build only denies full, focused and mutation tests, self-written scripts and CI triggers, and caps client waits at five minutes. Numeric limits are otherwise unlimited. Custom settings support a per-task verification-minute budget or a percentage of all observed task time; builds count as verification and script overlap counts once.

`tools/pre-execute` denies forbidden primary categories or script tags. The once-per-turn decision reserves admission synchronously across sibling agents, consumes it on execution, and releases an unused reservation when the tool result settles. Native and nested programmatic tool calls share this executor. A budget can deny or ask using the existing approval channel. Its prompt lists allow once, allow for this task and stop verification for this task; the current channel only implements allow once or reject, not task-wide choices.

Client launches use the existing cooperative deadline on `tools/execute`, propagate abort to the tool, and return `VERIFICATION_CLIENT_TIMEOUT` after execution settles. Policy settings appear as one read-only system-prompt line for root and child agents, recorded through the existing system-message projection.

The package entry's default service exposes `addTaskProhibitions(request: VerificationTaskRestrictions): void` for checklist consumers and remote `readWorkspace(request: VerificationWorkspaceRequest): VerificationView` for settings and grey-out decisions. The former appends category ids for an exact activity task; workspace settings remain unchanged. The tree checkbox has separate reversible state, so unchecking it does not remove checklist prohibitions.

## Model Experience

### Verification policy

#### What the model sees

One read-only policy line, fixed bilingual category refusals, an explicit already-used-full-run prefix, budget approval prompts and client timeout errors. No settings mutation tool is added.

#### Token effect

The policy line and occasional refusal or approval add text; no additional model request is made.

#### KV Cache effect

Changing workspace switches changes the system-prompt line and may invalidate its cached prefix. Unchanged settings produce the same line.

## Known Limitations and Deferred Work

Classification retains the activity service's limits: external agents, hidden script contents and remote CI contents are not inspected. Timeouts bound the tool's active wait, not background processes after the tool has returned. Task prohibitions and reservations are process-local; durable full-test counts are read from the activity ledger, while restored descendant ancestry retains the activity service's restart limitations. The approval UI has no task-wide response buttons. Settings changes affect subsequent decisions, not tools already admitted.

## Dev Note

The service does not change Core tool policy types or protocol constants.
