# @panedesk/dsh-host-bash-setup

<!-- summary -->

First-run Git Bash discovery Remote: it probes the common Windows install locations and commits the user-confirmed product selection that the base profiles gate their Bash and PowerShell rows on.

<!-- /summary -->

English | [中文](README.zh.md)

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Mount the gateway in a Web-facing profile; the Settings General row calls it over the generated `bashSetup` Remote face. `status` reports the host platform, the first probed Git Bash executable, the committed selection, and a `PANEDESK_BASH_PATH` override. `enable` commits one confirmed `{ enabled: true, bashPath }` document to `windows-bash.json` under the harness home; `disable` removes it, restoring the platform default. All filesystem facts and writes come from `@panedesk/dsh-bash-local`, which also owns the Loader expression the base profiles gate on.

### What a write means

The commit is the effect of the operator's confirmation in the settings row; the Remote itself asks no question. Composition reads the committed selection at the next profile mount, so a write takes effect after the application restarts, and the environment override keeps precedence over the committed selection.

## Understand the implementation

### Design concept

The gateway owns no state: every call re-reads the config file and the probe candidates through the bash-local module, so the settings row can never disagree with what the Loader expression will read. The probe is a synchronous existence check over the candidate table; verifying that a binary actually runs stays with the confirmed write.

### Source map

- `src/index.ts` — the `BashSetupGateway` Remote service and its three methods.
- `src/types.ts` — the wire types for the status snapshot.
- `tests/bash-setup.spec.ts` — platform reporting, the confirm-then-commit flow, and refusal of a path-less selection.

## Further Exploration

- [`@panedesk/dsh-bash-local`](../../shell/bash-local/README.md) — the candidate table, the config document format, and the base-profile gating.
- [`@panedesk/dsh-client-ui-settings-bash`](../../client/ui-settings-bash/README.md) — the Settings General row that drives this Remote.

## Model Experience

#### Model Experience effect

This package changes no model inputs or outputs.

#### KV Cache effect

No model call is involved, so there is no KV-cache effect.

## Known Limitations and Deferred Work

- **The probe checks existence only** — a candidate that exists but cannot run is still offered; the committed write does not launch the executable.
- **A write applies after restart** — live recomposition after a commit is deferred until a profile reload path owns it; the settings row states this.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The gateway name `bashSetup` is the Remote face name; client code reaches it as `ctx.remote.bashSetup`. Tests point `PANEDESK_HOME` at a scratch directory because the gateway reads the process environment, matching the product path.

</details>
