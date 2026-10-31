# Project opening guidance

English | [中文](README.zh.md)

Session-only project guidance and a custom product settings page. Part of the [Web client subsystem](../../../docs/subsystems/web-client.md).

## Behavior

The conversation overlay asks once per workspace path for Off, Remind only, or Automatic; Remind only is the initial draft, not an implicit approval. A successful selection is stored in the product profile's `ui-project-onboarding.projects` dictionary, never in the user's project. Product settings can change confirmed choices. Read-only settings disable writes; failures retain the prior visible selection and offer retry.

The owner-only `projectOpening.select` operation resolves matching seat projects from the complete authorized local catalog, applies their engine policies with revision checks, then persists the product preference. A failed persistence attempt restores prior modes unless another writer changed them; rollback failure requires reviewing engine policy before retrying. With no matching seat, the preference is stored without starting an engine. Newly imported seat definitions are not automatically assigned a previously saved mode: save the project's choice again after import.

The workflow-pack action inserts a getting-started request into the current composer and persists the draft. It never submits a message or writes project files. No new entry is added to the session launch screen.

## Model Experience

### Project guidance

#### What the model sees

Viewing or saving `ui-project-onboarding.projects` preferences adds no model context. The workflow-pack action changes only a human-visible draft until the user sends it.

#### Token effect

Viewing or saving preferences makes no model request and consumes no model tokens. Automatic mode may permit subsequent rule-driven model work.

#### KV Cache effect

The package does not change prompt prefixes or retained model history before the user submits a draft.

## Known Limitations and Deferred Work

- Workspace keys are host directory paths; aliases and symlinks are not merged. Seat projects sharing an exact directory receive the same explicit selection.
- Product persistence and engine journals are separate stores. A reported rollback conflict requires manual policy review; no cross-store atomicity is claimed.
