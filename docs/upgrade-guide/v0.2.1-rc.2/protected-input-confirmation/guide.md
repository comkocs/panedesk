---
kind: upgrade-guide
description: Recorded host inputs inside the launch workspace require owner confirmation before HMR applies a changed version.
---

# Protected input confirmation

English | [中文](guide.zh.md)

## Change

HMR requires authenticated owner confirmation for changed, recorded inputs inside the launch workspace; refusal or unattended operation preserves the running version and reports the blocked change. The panel names the path and candidate digest. Confirmation does not grant general workspace write access. Registered inputs acquire a baseline when workspace write access is granted; trusted configuration copies and plugin identities persist across restarts in the owner state directory outside the writable workspace.

A failed protected-input review now refuses new Agent creation rather than merely warning and continuing. One-shot headless commands exit nonzero with English and Chinese recovery instructions; Web session creation displays the refusal. Product-home snapshots remain inclusive by default: only exact diagnostic regular files are omitted, while ledger, Session, and projection-cache data remain protected.

## Migration

If admission reports a protected-input refusal, review the changed inputs and explicitly authorize workspace write access again before retrying creation. Do not interpret an earlier write grant as approval of later input changes.

Keep an authenticated owner frontend connected when editing recorded host inputs, review the displayed path and digest, and select **Confirm this version** only for the intended candidate. Sessions using `never` do not prompt and retain a passive inbox notice without starting a model turn. Keep the owner state directory outside writable workspaces; an overlapping location refuses a write grant. Inputs outside registered workspace records retain their existing reload behavior.

For edits made outside the running application, use the owner's editor outside the model sandbox, then start the profile with its existing owner home and connect the authenticated owner frontend. Startup uses approved configuration copies while review waits for the owner event stream. Review each changed recorded path and candidate digest; approval with HMR schedules reload, while a profile without HMR reports that a restart is required. Do not delete or edit the durable baseline to bypass a refusal. This flow does not certify Worker or arbitrary custom-loader execution; see the [boot limitations](../../../../packages/boot/app-boot/README.md#known-limitations-and-deferred-work).

See [HMR](../../../../packages/boot/hmr/README.md) and [approval](../../../../packages/interaction/user-approval/README.md).
