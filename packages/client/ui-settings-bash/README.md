# @panedesk/dsh-client-ui-settings-bash

<!-- summary -->

Settings General row that probes the Windows Git Bash installation through the Host and commits the confirmed selection in one click, with bilingual install instructions when nothing is found.

<!-- /summary -->

## Table of Contents

- [Using this package](#using-this-package)
- [Understanding the implementation](#understanding-the-implementation)
- [Further reading](#further-reading)
- [Model experience](#model-experience)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

## Using this package

Mount the row in web-facing profiles; it registers into `settings.general.item` behind the General section of Settings and reads every fact through the generated `bashSetup` Remote face. Off-Windows hosts see a one-line "applies to Windows hosts only" body with no actions. On Windows the row reports the first probe hit with its full path, and the button click is the confirmation that commits that executable to the product configuration the base profiles gate on. When the probe finds nothing, the row carries the bilingual install instructions instead. A committed selection renders with a restore action that removes the file and returns the host to the PowerShell default.

### What a click commits

The button click is the entire confirmation flow: no dialog precedes it, and nothing is written before it. The write itself happens in the Host gateway; this package only forwards the probed path.

## Understanding the implementation

### Design notes

The row holds one asynchronous view with three settled outcomes — probe hit, nothing found, or a committed selection — and derives every render branch from that view plus a busy/failure pair. The environment override is reported, not managed: when `PANEDESK_BASH_PATH` is set the row says so and offers no write, because the override outranks the committed selection at gate evaluation.

### Source map

- `src/client/BashSetupRow.tsx` — the row component and its state machine.
- `src/client/locales.ts` — the bilingual dictionary (zh is the key source).
- `src/client/index.ts` — slot registration and the Remote-face inject.

## Further reading

- [`@panedesk/dsh-host-bash-setup`](../../host/host-bash-setup/README.md) — the Remote gateway this row drives.
- [`@panedesk/dsh-bash-local`](../../shell/bash-local/README.md) — the candidate table and the committed product file.

## Model experience

#### Model experience impact

This package changes no model input or output.

#### KV-cache impact

No model calls are involved; no KV-cache impact.

## Known limitations and deferred work

- **Applies after restart** — the committed write is read at profile mount time, so the change takes effect on the next app start; the row states this in place.
- **No session-start hint** — the design also places a one-shot hint after a session starts; the row delivers the whole flow inside Settings and the hint has no clean slot yet.

<a id="dev-note"></a>
### Development note

<details>
<summary>Maintainer working context — click to expand</summary>

Component tests feed the row's inject face directly with scripted promises, in both zh and English, asserting that nothing is written before the confirmation click.

</details>
