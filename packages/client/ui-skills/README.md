---
description: "Read-only Skills settings section: built-in, user, and project skills with their source paths."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-skills

English | [中文](README.zh.md)

## Summary

Use the **Skills** settings section to see the skills this deployment can use. The skill list is read-only; global filesystem-provider scanning controls save through the existing profile configuration editor. Each row shows the skill name, its description, and the source path, and **Open source file** hands that path to the host's existing file opener.

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

Open **Skills** in Settings, optionally select a registered workspace, and choose **Load skills**. Built-in and user skills load without a workspace or session. Same-name skills show only their effective highest-priority source, as defined by the [filesystem catalog](../../skill/skill-filesystem/README.md). Selecting a workspace reloads its project roots without opening a project session; scope is global plus the selected project. Each scan root, including Claude Code, custom, and configured bundled roots, shows its full path, existence, valid skill count before deduplication, and an **Open directory** action. Source rows also offer **Open containing directory**. The Host resolves the registered ID rather than accepting an arbitrary directory.

Global provider controls show the full profile patch path with file/open-containing-directory actions. Enablement, default roots, and watching default to on; polling defaults to 100 ms. Toggles save immediately, while polling and newline-separated custom directory fields save on blur. Controls remain available when provider scanning is off; deployments without the profile editor display an explicit unavailable message. These controls apply to every project, not only the selected workspace.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half registers one `settings.section` named `skills`. Listing calls `skills.catalog` with the selected workspace ID or `undefined`; the Host aggregates provider-owned directory inspection. Saving calls `skills.configure`, which edits the addressed filesystem-provider config through `configEditor` and the normal Loader reconciliation path. Opening or revealing paths calls `session.openWorkspacePath`. The host half is an empty `apply`, present so the package holds a Loader row.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.section`.
- [skill-filesystem](../../skill/skill-filesystem/README.md) — the directories the catalog reads.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Explicit refresh** — the list is read on demand, not watched. Reload the section after changing skill files.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
