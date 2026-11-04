---
kind: upgrade-guide
description: "Local credentials move into a private directory, launch links become single-use, and HTTP API connections require an owner cookie."
---

# Owner private storage and launch links

English | [中文](guide.zh.md)

## Change

Default credentials move from `$PANEDESK_HOME/.credentials.yaml` to `$PANEDESK_HOME/private/.credentials.yaml`. Confined files and processes cannot read the parent directory. Custom paths remain unchanged and require a dedicated parent disjoint from the workspace. Explicit full-access tools are exempt.

Launch links expire after five minutes and exchange for a browser cookie once. `/connect` requires an owner browser cookie, not a launch token, and returns a separate API Peer cookie. New browser and API cookies default to session storage instead of persistent storage; signed expiry remains 30 days unless configured. Existing cookies are not revoked, and browser session restoration may retain session cookies. New browsers require POSIX controlling-terminal confirmation; then refresh the clean page. Restart may require login again. Windows Web and noninteractive services refuse new logins by default.

## Migration

Windows Web and noninteractive services require disabling confirmation in protected configuration. Windows asks on first startup; acceptance writes `$PANEDESK_HOME/local.patch.yml`. Manual overlays need both keys because connection rows replace entire configurations:

```yaml
- id: connection
  config:
    requireOwnerConfirmation: false
    trustedHosts: !!js ctx.webStartup.trustedHosts
```

Anyone holding an unused launch link can then log in. Keep confirmation for interactive POSIX use. To restore it, remove the override or set `requireOwnerConfirmation: true`, then restart; Windows refuses new logins but existing cookies remain valid. Downgrades neither discover nor reverse relocated credentials without explicit path configuration.

1. Back up credentials privately. Startup copies default credentials into `private`, validates and synchronizes them, then removes the original. Identical copies permit restart; conflicts stop startup, preserving both. Custom paths do not move.
2. Put a custom credential file in a dedicated directory outside the workspace and other required readable roots. Do not create hard-link copies of owner material. Confined execution refuses material it cannot isolate; do not switch to full access merely to suppress that refusal.
3. Sign in again after the signing-key move. Open a fresh CLI Web link within five minutes. Desktop keeps its inherited-IPC cookie in memory without terminal confirmation. Never expose links or cookies in model-visible logs or arguments. Restart the Host for expired or consumed links.
4. HTTP API clients must obtain the browser owner cookie through an owner-controlled channel, then request `/connect?interactions=none` or `answer` with that cookie. Keep the returned API cookie separate from browser storage. The TypeScript and Python SDK running-Host credential-file flow is unchanged.
5. For persistence, set positive `cookieMaxAgeDays` in the protected connection configuration, preserving other keys; otherwise omit it. Restart and exchange a new link. Verify `Set-Cookie` omits `Max-Age` and `Expires` unless configured. Session storage does not revoke credentials.
6. Confirm that owner login and credential resolution work, the default old document is absent, and sandboxed reads of the private directory fail. Before rolling back, configure the older release to use the relocated file explicitly; automatic downgrade relocation is not provided.
