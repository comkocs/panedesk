---
description: "Read-only Skills settings section: built-in, user, and project skills with their source paths."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-skills

English | [中文](README.zh.md)

## Summary

Use the **Skills** settings section to see the skills this deployment can use. The list is read-only. Each row shows the skill name, its description, and the source path, and **Open source file** hands that path to the host's existing file opener.

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

Open **Skills** in Settings, optionally select a registered workspace, and choose **Load skills**. Built-in and user skills load without a workspace or session. Same-name skills show only their effective highest-priority source, as defined by the [filesystem catalog](../../skill/skill-filesystem/README.md). Selecting a workspace includes its project skills; the Host resolves the registered ID rather than accepting an arbitrary directory.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half registers one `settings.section` named `skills`. Listing calls `skills.catalog` with the selected workspace ID or `undefined`, and opening a row calls `session.openWorkspacePath` with the listed path. The host half is an empty `apply`, present so the package holds a Loader row.

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
