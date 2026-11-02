---
kind: upgrade-guide
description: Recorded host inputs inside the launch workspace require owner confirmation before HMR applies a changed version.
---

# Protected input confirmation

English | [中文](guide.zh.md)

## Change

HMR requires authenticated owner confirmation for changed, recorded inputs inside the launch workspace; refusal or unattended operation preserves the running version and reports the blocked change. The panel names the path and candidate digest. Confirmation does not grant general workspace write access. Registered inputs acquire a baseline when workspace write access is granted; trusted configuration copies and plugin identities persist across restarts in the owner state directory outside the writable workspace.

## Migration

Keep an authenticated owner frontend connected when editing recorded host inputs, review the displayed path and digest, and select **Confirm this version** only for the intended candidate. Sessions using `never` do not prompt and retain a passive inbox notice without starting a model turn. Keep the owner state directory outside writable workspaces; an overlapping location refuses a write grant. Inputs outside registered workspace records retain their existing reload behavior.

See [HMR](../../../../packages/boot/hmr/README.md) and [approval](../../../../packages/interaction/user-approval/README.md).
