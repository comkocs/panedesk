---
kind: upgrade-guide
description: "Local credentials move into a private directory, launch links become single-use, and HTTP API connections require an owner cookie."
---

# Owner private storage and launch links

English | [中文](guide.zh.md)

## Change

Default credentials move from `$PANEDESK_HOME/.credentials.yaml` to `$PANEDESK_HOME/private/.credentials.yaml`. Confined files and processes cannot read the parent directory. Custom paths remain unchanged and require a dedicated parent disjoint from the workspace. Explicit full-access tools are exempt.

Launch links expire after five minutes and exchange for a browser cookie once. `/connect` requires an owner browser cookie, not a launch token, and returns a separate API Peer cookie. Signed cookies retain their configured lifetime. New browsers require POSIX controlling-terminal confirmation; then refresh the clean page. Restart may require login again. Windows Web and noninteractive services refuse new logins by default.

## Migration

Windows Web and noninteractive services require disabling new-browser confirmation in protected configuration. The Windows distribution asks before first starting the Host; acceptance writes `$PANEDESK_HOME/local.patch.yml`. Otherwise new logins are refused. Manual overlays need both keys because connection rows replace entire configurations:

```yaml
- id: connection
  config:
    requireOwnerConfirmation: false
    trustedHosts: !!js ctx.webStartup.trustedHosts
```

Anyone holding an unused launch link can then log in. Protect launch links and cookies; leave confirmation enabled for interactive POSIX use. To revoke the choice, remove the override or set `requireOwnerConfirmation: true`, then restart. Windows will refuse new browser logins again; this setting does not revoke existing cookies. Downgrading without configuring the relocated credential path makes the old release appear to have no saved credentials; it does not reverse relocation.

1. Keep an owner-only credential backup. Startup copies default-path credentials into `private`, validates and synchronizes them, then removes the old document. Identical copies allow restart to resume; conflicts stop startup and preserve both copies for reconciliation. Custom paths do not move automatically.
2. Put a custom credential file in a dedicated directory outside the workspace and other required readable roots. Do not create hard-link copies of owner material. Confined execution refuses material it cannot isolate; do not switch to full access merely to suppress that refusal.
3. Sign in again after upgrading: the browser signing key has moved. Open a fresh CLI Web launch link once, within five minutes. Desktop receives a fresh cookie over its inherited IPC channel and keeps it in memory, without terminal confirmation. Do not publish launch links or copy cookies into model-visible logs or arguments. Restart the Host if a manually retained link has expired or was consumed.
4. HTTP API clients must obtain the browser owner cookie through an owner-controlled channel, then request `/connect?interactions=none` or `answer` with that cookie. Keep the returned API cookie separate from browser storage. The TypeScript and Python SDK running-Host credential-file flow is unchanged.
5. Confirm that owner login and credential resolution work, the default old document is absent, and sandboxed reads of the private directory fail. Before rolling back, configure the older release to use the relocated file explicitly; automatic downgrade relocation is not provided.
