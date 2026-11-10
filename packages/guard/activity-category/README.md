---
description: "Task activity classification and display-only execution timing."
kind: "package-reference"
---

# @panedesk/dsh-activity-category

English | [中文](README.zh.md)

## Summary

Classifies tool executions and model streams without enforcing verification policy. The default base composition installs the `activityCategory` service. The subagent tree and parent composer display its task totals.

## Use this package

The package entry exports `ACTIVITY_CATEGORIES`, `ACTIVITY_RULES`, `ACTIVITY_REFUSAL`, `classifyActivity`, `activitySummary` and their types. `activityCategory.classify(toolName, args, session)` resolves the calling task's confirmed created paths and workspace rules; `activityCategory.read(sessionId)` returns category counts, cumulative milliseconds, shares and the current or last operation. A child activation is one task; a committed human-origin message starts a root task, while synthetic notices do not reset it. New child activations reset their own accounting.

`projects` defaults to an empty dictionary of canonical workspace paths to ordered `{ contains, category }` rows. The first nonempty literal match overrides the default command category. The workspace selector and editor live in Panedesk features settings; values use the existing profile configuration rather than files in the user's project. Classification rules are display preferences, not enforcement switches.

The ordered default rules distinguish edits, reads/searches, builds, focused/full/mutation tests, client/end-to-end execution, CI triggers, self-written scripts, waits and other calls. Model streams are timed separately. Test file, case and filter arguments select focused tests; runner mode and output-only arguments do not. A successful file-modification tool's `operation: create` metadata supplies script evidence. Existing files and updates do not qualify. Relative execution paths resolve against the tool's working directory, including simple shell `cd` sequences; interpreter arguments and direct executable paths are compared to confirmed task-created paths, including descendants.

Tool execution uses `tools/execute`; model timing wraps `llm/stream`. Start/end auxiliary facts use the existing call journal, with monotonic elapsed measurements and no model content. Finished totals survive process restarts. Unmatched starts tick only while the service knows the operation is live; a restart does not invent continued execution. Counts sum operations and durations sum observed execution time, so concurrent operations can exceed wall time. The script tag overlaps its primary category and never adds to the denominator a second time. The existing tree resource supplies all activity views at its configured refresh cadence.

## Model Experience

### Display-only accounting

#### What the model sees

No additional prompt, tool or refusal. The exported refusal templates are available to separate verification consumers; this service does not invoke them.

#### Token effect

None. Accounting launches no model requests and adds no request content.

#### KV Cache effect

None. Request prefixes are unchanged.

## Known Limitations and Deferred Work

External registry nodes cannot be classified. Tests hidden inside newly written scripts carry the script tag rather than an inferred test suite category. Remote CI contents are unknown; only the push or trigger is visible. Shell aliases, variable expansion, nested shells and dynamically computed script paths are not interpreted. Background launch timing measures the tool call, not the detached process lifetime; later blocking output calls are waits. Crashes can leave an operation with unknown final duration. Accounting read/write failures are logged without preventing tool or model execution or replacing its result; affected observations may be missing. Older journal readers report these unrecognized auxiliary facts as incomplete rather than interpreting them as calls.

## Dev Note

None.
