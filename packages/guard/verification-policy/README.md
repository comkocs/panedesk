---
description: "Workspace verification switches enforced before tool execution."
kind: "package-reference"
---

# @panedesk/dsh-verification-policy

English | [中文](README.zh.md)

## Summary

The Web/Desktop composition installs `verificationPolicy`. It consumes the activity service's classification, task timing and refusal text rather than classifying commands independently. Enabled defaults to true; disabling it leaves activity accounting running without decisions or client timeouts.

## Use this package

Settings are workspace-keyed records with `version: 1`. Without project recording they remain in the `workspace_verification` storage-domain, table `settings`. Enabling project recording copies the original settings unchanged into the project SQLite `settings` table; failed migration leaves the original adapter active. `src/storage.ts` selects storage without changing admission decisions. Disabling recording selects the original workspace settings again; the project copy is retained for re-enabling. Nothing is written into the project or exposed through `panedesk_settings`.

Default allows one full test run across a root user's turn and all its child runs, denies mutation tests and allows other categories. Unlimited allows all categories without limits. Build only denies full, focused and mutation tests, self-written scripts and CI triggers, and caps client waits at five minutes. Numeric limits are otherwise unlimited. Custom settings support a per-task verification-minute budget or a percentage of all observed task time; builds count as verification and script overlap counts once.

`tools/pre-execute` denies forbidden primary categories or script tags. The once-per-turn decision reserves admission synchronously across sibling agents, consumes it on execution, and releases an unused reservation when the tool result settles. A command that runs the full suite in two or more segments, split on `;`, `&&`, `||`, a newline, or a pipe, spends that allowance and is refused with the same already-used sentence, even when an earlier segment would classify the whole call as focused.  Native and nested programmatic tool calls share this executor. A budget can deny or ask using the existing approval channel. Its prompt lists allow once, allow for this task and stop verification for this task; the current channel only implements allow once or reject, not task-wide choices.

Client launches use the existing cooperative deadline on `tools/execute`, propagate abort to the tool, and return `VERIFICATION_CLIENT_TIMEOUT` after execution settles. Policy settings appear as one read-only system-prompt line for root and child agents, recorded through the existing system-message projection.

The package entry's default service exposes `addTaskProhibitions(request: VerificationTaskRestrictions): void` and its remote wrapper `prohibitTaskCategories(request: VerificationTaskRestrictions): void` for checklist consumers, and remote `readWorkspace(request: VerificationWorkspaceRequest): VerificationView` for settings and grey-out decisions. Both prohibition methods append category ids for an exact activity task; workspace settings remain unchanged. The tree checkbox has separate reversible state, so unchecking it does not remove checklist prohibitions.

The same system-prompt line tells the agent to call `verification_checklist` with a one-sentence requirement title and its planned checks before starting work, or to submit an empty items array when there is nothing to verify. That sentence is added only when the assembled tool list includes `verification_checklist`.

## Model Experience

### Verification policy

#### What the model sees

One read-only policy line, fixed bilingual category refusals, a one-sentence already-used-full-run refusal, budget approval prompts and client timeout errors. When `verification_checklist` is in the assembled tool list, the policy line also carries this instruction: "Before you start work, call verification_checklist with a one-sentence requirement title and the checks you plan to run. If there is nothing to verify, submit an empty items array." No settings mutation tool is added.

#### Token effect

The policy line and occasional refusal or approval add text; no additional model request is made.

#### KV Cache effect

Changing workspace switches changes the system-prompt line and may invalidate its cached prefix. Unchanged settings produce the same line.

## Known Limitations and Deferred Work

Classification retains the activity service's limits: external agents, hidden script contents and remote CI contents are not inspected. Timeouts bound the tool's active wait, not background processes after the tool has returned. Task prohibitions and reservations are process-local; durable full-test counts are read from the activity ledger, while restored descendant ancestry retains the activity service's restart limitations. The approval UI has no task-wide response buttons. Settings changes affect subsequent decisions, not tools already admitted.

## Dev Note

The service does not change Core tool policy types or protocol constants.
