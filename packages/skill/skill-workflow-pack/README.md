---
description: "Portable workflow-pack guidance and directory resources for explicit skill invocation."
kind: "package-reference"
---

# Bundled workflow pack

English | [中文](README.zh.md)

## Summary

The provider exposes the workflow-pack guide and resources through the skill registry. Loading it does not run tools, start models, or modify projects.

## Table of Contents

- [Use this package](#use-this-package)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

This [skill subsystem](../../../docs/subsystems/skills.md) provider registers `workflow-pack` for user and model invocation. Its body is the portable [getting-started guide](../../../templates/workflow-pack/getting-started.md), with the complete pack exposed as a directory resource. It checks requirements before generating project rules; loading the skill does not write files or start models.

The build copies `templates/workflow-pack/` into `lib/workflow-pack/`. Maintain the template source only. An absolute `assetRoot` can override the packaged resource directory; incomplete resources fail plugin activation.

<a id="dev-note"></a>
## Dev Note

The published resource list lives in `package.json`; build-time copying lives in `tsdown.config.ts`.

<a id="model-experience"></a>
## Model Experience

### Workflow-pack guidance

#### What the model sees

Discovery adds the `workflow-pack` description to the skill catalog. Invocation returns the `getting-started.md` guide and directory resource guidance through the skill consumer; the 215-rule table is not injected automatically.

#### Token effect

The package makes no model calls. The catalog description and requested guide consume model context through the skill consumer; additional rule or tool reads add context only when requested.

#### KV Cache effect

Loading the provider does not rewrite prompt prefixes. Invoked skill text remains in the consumer's retained tool history; subsequent reads append content rather than replacing earlier results.

## Known Limitations and Deferred Work

- The trimming tool retains Chinese card keys and generated filenames for compatibility. Python 3.11 or later is required to run it.
- The provider supplies resources and guidance, not authorization to modify a user's project.
