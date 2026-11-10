---
description: "The model-facing verification_checklist tool: one requirement title and its planned checks, recorded on the calling session."
kind: "package-reference"
---

# @panedesk/dsh-tool-verification-checklist

English | [中文](README.zh.md)

## Summary

`dsh-tool-verification-checklist` lets the agent record the checks it plans to run for one requirement before it starts. Each call names the requirement in one sentence and lists the checks, or sends an empty list when there is nothing to verify. Submitting the same title again replaces that requirement; other requirements stay. The list belongs to the calling session and remains across turns. Submitting does not wait for approval.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package with no configuration. The tool name is `verification_checklist`. A call carries `title`, one sentence naming the requirement, and `items`, each with `category` (one of `write`, `read`, `build`, `test-focused`, `test-full`, `mutation`, `client`, `ci`, `script`, `wait`, `model`, `other`), `note` (one short line), and `minutes` (estimated minutes). The same title replaces its previous checklist. A call outside an agent session is rejected.

```yaml
- name: '@panedesk/dsh-tool-verification-checklist'
```

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees `verification_checklist`: a required `title` string and a required `items` array of `{ category, note, minutes }` objects. The description says to submit the checklist before starting, to resubmit the same title to replace that requirement, and to submit an empty `items` array when there is nothing to verify.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged.

### System prompt

#### What the model sees

The verification policy line also carries this instruction.

```markdown
Before you start work, call verification_checklist with a one-sentence requirement title and the checks you plan to run. If there is nothing to verify, submit an empty items array.
```

#### Token effect

One extra sentence on the existing policy line.

#### KV Cache effect

The sentence is fixed, so it does not change between turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Single-owner scope only** — the list belongs to the calling agent session, and a non-agent caller is rejected.
- **Same-title replacement only** — there is no per-item edit and no way to remove one requirement without resubmitting the list.
- **No approval wait** — submitting records the checklist and returns immediately.

<a id="dev-note"></a>
## Dev Note

The plugin exports `name`, `inject`, and `apply` with no default export. `inject` lists only `tools` and `sessionProjections`, so the tool catalog can boot it without the activity or verification services.
