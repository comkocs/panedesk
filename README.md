# Panedesk

English | [中文](README.zh.md)

**Panedesk** (Chinese name 窗台, "window sill") is an open-source, plugin-based coding-agent harness: one runtime for the agent loop, model routing, subagents, a session ledger, permissions and sandboxing. The name joins *pane* (each agent works in its own window) and *desk* (the ticket desk that will dispatch them).

> Built on DSH (DeepSeek Harness). Panedesk is an independent fork of [DSH](https://github.com/deepseek-ai/deepseek-harness) 0.2.1-rc.2 and is not affiliated with, endorsed by, or sponsored by DeepSeek. "DeepSeek Harness" is a registered trademark of DeepSeek; see [BRAND_GUIDELINES.md](BRAND_GUIDELINES.md).

## Status

The public repository includes a headless CLI with model routing and subagents, plus Web and desktop clients. The Web composition provides a session subagent tree with read-only monitoring, ledger statistics, node health and administration, and a read-only skills catalog. Seat orchestration and its UI are opt-in; installing the packages does not enable automatic opening. Separate private plugins also exist; they are not described here.

Planned next: public-release preparation, then long-running sessions and subagent supervision, then upstream-sync automation. See the [Panedesk architecture](docs/panedesk/architecture.md) for public composition and configuration.

## Platform behavior

On Linux, start the host in tmux or with `systemd-run --user --scope -p Delegate=yes` so it runs in a delegated user scope. A login session's `session-N.scope` is not delegated to the user; starting there directly produces an English/Chinese startup warning and leaves owner-source verification ineffective. See the [Linux deployment prerequisites](docs/upgrade-guide/v0.2.1-rc.2/linux-owner-source/guide.md).

On Linux, the deny-only retired identity filter can mistake an ordinary owner connection for an unknown source and refuse admission; it neither permits historical product identities nor refuses new sandbox starts. At approximately 100,000, 1 million, and 2 million retired identities inserted, the estimated false-positive rates are 0.00047%, 2.07%, and 14.3%, respectively. A browser's cgroup identity is stable, so a false positive persists until host restart. Close all sandbox sockets before restarting the host to clear the filter. See the [Linux upgrade guide](docs/upgrade-guide/v0.2.1-rc.2/linux-owner-source/guide.md).

Windows product-sandbox TCP connections cannot act as owner even with a valid cookie: admission checks host-owned Job membership, not browser integrity, AppContainer status, or token restrictions. Missing connection ownership refuses owner access. Ordinary browsers remain eligible. Windows behavior is verified with substitutes, not native hardware. Scheduled tasks, WMI, COM, and ShellExecute delegation to an outside process remain unverified hardening work required before the M9 stable release. This Windows-specific description supersedes the earlier platform limitation retained in the session-cookie section below. See the [Windows upgrade guide](docs/upgrade-guide/v0.2.1-rc.2/windows-owner-source/guide.md).

Windows sandbox processes share the host console and can inject keys into CLI / TUI to impersonate owner approval or commands. Use an authenticated Web or desktop frontend for owner approval on Windows; console isolation is deferred. Interactive Windows CLI / TUI startup prints this warning.

Windows Web refuses new browser logins unless the owner disables new-browser confirmation in protected configuration. The Windows distribution asks on first run; accepting writes a connection row with both `requireOwnerConfirmation: false` and `trustedHosts: !!js ctx.webStartup.trustedHosts`. Sign in again after upgrading because the signing key moved. Disabling confirmation makes an unused launch link sufficient for login; protect links and cookies. To revoke this choice, remove the override or set confirmation to `true`, then restart; Windows will refuse new browser logins again, and existing cookies are not revoked by this setting. See the [upgrade instructions](docs/upgrade-guide/v0.2.1-rc.2/owner-private-storage/guide.md).

An owner private directory may be inside the workspace on Linux/macOS, but a workspace inside an owner directory is refused. Landlock excludes protected first-level branches from write grants; other existing branches remain writable, but new files or directories at the workspace root cannot be created. Windows permits read-only startup when the workspace contains owner storage, but refuses write authorization.

Desktop uninstall preserves the Harness home and its owner read-protection labels. Before deleting the home or removing the CLI completely, stop all Panedesk processes and follow [manual owner-label removal](packages/sandbox/sandbox-windows-acl/README.md#owner-label-removal-before-uninstall).

Restricted file tools and sandbox processes exclude owner credential directories, including atomic replacements; ordinary attachments remain readable. Linux uses directory mounts or Landlock sibling-tree grants, macOS uses Seatbelt exclusions, and Windows uses Medium no-read-up/no-write-up labels on credential and crash directories. This is targeted owner-material protection, not general home-directory secrecy. New Web browsers require a POSIX controlling-terminal confirmation; Windows Web and noninteractive services refuse new logins unless the owner explicitly disables confirmation in protected configuration, accepting launch-link possession as authority. See [login and service configuration](packages/client/connection/README.md#browser-authentication-and-request-trust) before upgrading a service deployment. Desktop owner cookies use memory-only sessions and IPC; Windows third-party platform cookies remain readable to low-integrity commands because userData is not labeled. See [desktop security details](apps/desktop/README.md).

Windows defaults to read-only when no permission mode is explicitly selected. The first workspace write requests confirmation from the authenticated owner frontend; Settings can also preauthorize or revoke a workspace. Windows native enforcement has not been validated on a Windows machine. With the default handle backend, file-tool reads, directory listings, new-file creation and existing-file rewrites succeeded on a Windows Server 2025 machine under an administrator account; a standard account has not been tested on Windows hardware. Protected-input exclusions preserve ordinary workspace writes instead of rejecting an entire overlapping workspace; [provider limitations](packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work) distinguish parameter checks from native enforcement. Unrelated plugin projects and source clones remain writable. Registered protected host inputs acquire a persistent baseline when workspace write access is granted; HMR requires authenticated owner confirmation for changes, preserving the running version and reporting blocked changes on refusal or unattended operation. `danger-full-access` explicitly grants the host user's full write authority, including configuration and plugins; `plugin_manager` still requires owner approval for each change.

Windows state storage and its ancestors must deny sandbox-token writes; unsafe records cannot authorize writes, while read-only startup omits untrusted workspace configuration. Revocation scans the selected workspace after restart, including `node_modules`, and succeeds only after token checks deny writes at the root and every matching explicit ACE location. See the [Windows recovery guide](docs/upgrade-guide/v0.2.1-rc.2/windows-workspace-write-access/guide.md) for exact-directory/SID `icacls` commands and limits.

For a legacy Windows workspace grant without an authorization record, close its sandbox processes and run this PowerShell line as the workspace owner, replacing `C:\old-workspace` with the canonical path used when the grant was created and `C:\current-workspace` with its current location: `$old='C:\old-workspace'; $dir='C:\current-workspace'; $h=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($old)); $sid='S-1-4-'+(([BitConverter]::ToUInt32($h,0)%1073741823)+1)+'-'+(([BitConverter]::ToUInt32($h,4)%1073741823)+1); icacls $dir /remove "*$sid" /T`. This removes that workspace-derived subject, not every `S-1-4-*` subject; do not substitute the owner account or Everyone. Inspect failures and repeat for each known old grant path. Unknown old paths cannot be identified from the SID prefix alone.

Owner-installed MCP servers and providers run with their own capabilities, outside Panedesk sandbox enforcement and first-write confirmation. Review their write capabilities before installing them. Their profile configuration remains protected from confined model writes, and plugin management changes require authenticated owner approval.

On Linux and macOS, a custom launcher that starts the CLI with an IPC channel must pass `--disable-sigusr1` on the Node command line; `NODE_OPTIONS` does not count, and a missing flag exits before profile and credential loading instead of restarting. Terminal, shell, systemd, pnpm-script, and SDK pipe launches are unchanged. The Windows desktop CLI launcher includes `--disable-sigusr1` and has test coverage, but has not been run on a Windows machine. See the [IPC launch upgrade guide](docs/upgrade-guide/v0.2.1-rc.2/ipc-cli-launch/guide.md).

In Web mode the owner's login cookie is stored in the system browser's configuration directory. A process inside the sandbox can read it. Connection-source admission blocks replay from registered product sandboxes when the platform prerequisites are available; otherwise replay remains possible. See [sandbox session isolation and limitations](#sandbox-session-isolation-and-limitations).

Protected-input capture for the first write authorization yields between bounded batches so Web connections and heartbeats remain serviceable during a large capture. Capture and input rechecks still scan protected inputs; installed plugin trees and workspaces overlapping the product home can increase their cost.

| Platform | Sandbox | Write access | Bash default | Known limitations |
| --- | --- | --- | --- | --- |
| Windows | Restricted token with low integrity and directory capability ACLs; partial confinement with targeted owner-directory read protection. | Without an explicit mode, read-only with no workspace write grants; owner-directory read-protection labels still apply. The first write in a workspace requests English/Chinese confirmation; allowing records consent and makes the workspace writable while protected paths remain non-writable. Settings can preauthorize or revoke a workspace. Unattended sessions do not prompt: they stay read-only and explain how to enable writes. Explicit modes remain effective. | Disabled without an environment or settings selection; PowerShell is the alternative. | After permissions tighten (revocation or new protected roots), already-open processes and handles are not terminated; new tool calls immediately use the new policy. A persistent model terminal that rejects input after its permissions change must be closed and reopened. The permission-mode selector does not immediately reflect directory records. |
| Linux | bubblewrap (`bwrap`), with Landlock as fallback. | Defaults to workspace-write for workspace and temporary roots; explicit mode selection overrides it. | Enabled, using the configured Bash or `bash` on PATH. | Missing or unusable bubblewrap tries Landlock; no usable runner or insufficient protected-input enforcement means refusal, never unconfined execution. Older Landlock ABIs may provide partial confinement. Native Node/workflow process tests require `PANEDESK_CI_NATIVE_SANDBOX=required`; otherwise they skip with a reason. Not every kernel configuration has been validated; the persistent pwsh terminal is unavailable under the native sandbox (no output reaches the reader; calls time out). |
| macOS | Seatbelt through `sandbox-exec`. | Defaults to workspace-write for workspace and temporary roots; explicit mode selection overrides it. | Enabled, using the configured Bash or `bash` on PATH. | Paths are normalized on the host. Seatbelt does not hide host processes; platform-injected regressions do not constitute native macOS validation. |

<a id="sandbox-session-isolation-and-limitations"></a>
## Sandbox session isolation and limitations

When the workspace contains the product home, such as when starting in `$HOME`, the first write authorization scans overlapping protected directories individually; a fresh Linux development home measured 18–32 ms across headless and Web hosts, but installed plugin trees can cost more. Start in a project directory rather than using `$HOME` as the workspace.

Bubblewrap gives both confined modes a private `/tmp` and masks host tmux, screen, session-bus, X11 and Wayland socket directories, including explicit runtime-directory overrides. Tools requiring these host sessions are unavailable inside that sandbox; ordinary temporary files use the private tmpfs. macOS Seatbelt denies outbound UNIX sockets under temporary and configured session directories; native macOS validation remains outstanding. See [runner details](packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work).

Linux runners apply Landlock abstract-UNIX socket scope on kernels with ABI 6 or later. Without that scope, abstract sockets remain reachable: on an X11 desktop a sandbox process may inject keys into other windows. Startup is not refused for this limitation. Sandbox network namespaces plus user-space networking are required before the M9 stable release.

Landlock-only machines cannot hide pathname session sockets. If conventional user tmux, screen or session-bus locations exist, command startup warns in English and Chinese but does not refuse execution or change its exit code. Such sessions can execute commands outside confinement; run them under a separate user account. Sandbox network namespaces plus user-space networking are required before the M9 stable release.

Loopback networking is unrestricted. If local sshd accepts an available private key, `ssh localhost` can escape the sandbox. `~/.ssh` is not masked, preserving SSH-based Git pushes. Local loopback restrictions are required before the M9 stable release. These limits also mean session isolation is not a general sandbox-network guarantee; explicit full-access execution remains unchanged.

On Linux, host file operations performed for the model — reads, writes, edits, directory creation, staging and publication, metadata probes, and directory listing — open each canonical ancestor directory one component at a time without following links and address single entries through retained directory descriptors; a workspace directory replaced by a link cannot redirect these operations. On macOS, host file operations still resolve by path: a sandboxed process that replaces a workspace subdirectory with a link can direct host writes outside the authorized workspace, including in the default workspace-write mode. This restriction is maintained until a native directory-relative backend is verified on macOS. On Windows, the default `experimental` handle backend opens children relative to retained directory handles and refuses reparse points; its supported operations and replacement restrictions are described in [fs-local](packages/fs/fs-local/README.md#use-this-package). Set `windowsHandleBackend` to `disabled` only through an owner-approved protected profile or overlay to select the legacy path backend. With that backend, a sandboxed process can redirect host writes outside the authorized workspace by replacing a workspace subdirectory with a link once the owner grants workspace write; Windows defaults to read-only. This restriction remains for the legacy path backend.

Owner cookies default to browser-session storage; persistence requires protected Host configuration. With the default new-browser confirmation, a login confirmed in the host terminal stays valid only for that host process: after a restart the previously confirmed cookie is refused and a fresh launch link requires terminal confirmation again. Protected host configuration that sets `requireOwnerConfirmation` to `false` logs in without terminal confirmation and keeps the same cookie valid across restarts. On Linux, registered product-sandbox connections launched through the local subprocess provider are refused even with a valid cookie when cgroup v2 user delegation and native socket-cgroup attribution are available. The opt-in experimental Python runtime uses the managed subprocess provider and preserves this Linux registration. Missing prerequisites produce a bilingual startup warning and leave cookie replay possible; enable user-session delegation or run untrusted processes under a different account. Socket attribution is verified on Linux 7.0; its minimum kernel version is not established. macOS Web startup reports missing product-sandbox connection identification and is not claimed to block replay. Windows uses host-owned Job membership and TCP ownership to identify product sandboxes; see the [Windows prerequisites and remaining limits](docs/upgrade-guide/v0.2.1-rc.2/windows-owner-source/guide.md). See the [Linux upgrade prerequisites](docs/upgrade-guide/v0.2.1-rc.2/linux-owner-source/guide.md). See [authentication behavior](packages/client/connection/README.md#browser-authentication-and-request-trust) and [remaining limitations](packages/client/connection/README.md#known-limitations-and-deferred-work).

## What changed from DSH

- **Slim by default.** The default `slim` preset provides the headless core, context compaction, large-output spill, the tool-call timeout guard and `AGENTS.md` loading. The [generated preset table](docs/panedesk/architecture.md) owns the current row counts and membership.
- **Full on demand.** The `full` preset is the upstream DSH headless composition. It, and the upstream `web`, `acp` and `sdk` profiles, become available when the `@panedesk/full` package is installed beside the launcher (it is in the development workspace).
- **Privacy off by default.** Session-log upload, plugin-inventory upload, session telemetry, anonymous identity headers and Desktop product analytics all default to off and can be switched on.
- **No brand opener.** The system prompt no longer starts with a "powered by" harness line.
- **Commands.** The CLI is `panedesk`, with the short name `pdesk`.
- **Names after the rename.** The launcher package is `panedesk` (commands `panedesk` and `pdesk`), every other workspace package is `@panedesk/*` with only the scope swapped (`@panedesk/dsh-*` and the like remain), and the home directory defaults to `~/.panedesk`, overridden by `PANEDESK_HOME` — `~/.dsh` and `DSH_HOME` are never read. The user-facing variables are `PANEDESK_PERMISSION_MODE`, `PANEDESK_TELEMETRY_*`, `PANEDESK_TOOLS_MODE` and `PANEDESK_AGENTS_HOME` (still defaulting to `~/.agents`); the remaining `DSH_*` variables (tests, snapshots, CI, releases) keep their names. The rename itself is mapped and replayed by `scripts/panedesk/rename/` (English README included; upstream fixes go through that script first).

## Quick start from source

Requirements: Node.js `^22.19 || >=24`, pnpm 11 (via Corepack).

From the repository root, run one setup command:

```sh
pnpm run setup
```

This performs the frozen install, builds the native addon and host libraries (including the CLI runtime), checks the CLI runtime closure, and initializes the default slim profile. You do not need to run `compile-referenced-projects` yourself. Git hooks remain opt-in via `pnpm run hooks:install`.

Run the built CLI directly, or use `pnpm run setup -- --link` to install the `pdesk` and `panedesk` commands globally after configuring `PNPM_HOME`:

```sh
node apps/cli/lib/bin.js --help
node apps/cli/lib/bin.js init
```

With the global command linked, the second command is `pdesk init`. Choose Anthropic Messages, OpenAI Chat Completions, or OpenAI Responses, then enter the base URL and model ID. Reference an environment-variable name for the key (recommended), or type it without echo into the owner-only credentials file. Init writes only the key reference into `$PANEDESK_HOME/cordis.patch.yml` and backs up an existing patch before updating it. Set the referenced variable in the environment when using that option; slim has no model route until you configure one.

```sh
node apps/cli/lib/bin.js "summarize this repository"
```

For manual provider overlays, use the [provider examples](examples/providers) and the [patch-order reference](docs/panedesk/architecture.md). Launcher flags (`--profile`, `--patch`, dumps) come before app flags such as `--json`. See the platform table before running tools on Windows.

## Presets

See the [generated preset table and composition notes](docs/panedesk/architecture.md) for current row counts and plugin membership. It is generated by `scripts/panedesk/gen-slim-base.ts --table`; the counts describe base declarations before headless patches, platform conditions, and overlays, not enabled plugins.

For npm dry-runs, active release helpers, and inherited publishing commands, see [release scripts](docs/panedesk/release.md).

## License

MIT. The upstream notice `Copyright (c) 2026 DeepSeek` is kept and `Copyright (c) 2026 Panedesk contributors` is added; see [LICENSE](LICENSE). Third-party notices inherited from DSH are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
