# Panedesk

English | [中文](README.zh.md)

**Panedesk** (Chinese name 窗台, "window sill") is an open-source, plugin-based coding-agent harness: one runtime for the agent loop, model routing, subagents, a session ledger, permissions and sandboxing. The name joins *pane* (each agent works in its own window) and *desk* (the ticket desk that will dispatch them).

> Built on DSH (DeepSeek Harness). Panedesk is an independent fork of [DSH](https://github.com/deepseek-ai/deepseek-harness) 0.2.1-rc.2 and is not affiliated with, endorsed by, or sponsored by DeepSeek. "DeepSeek Harness" is a registered trademark of DeepSeek; see [BRAND_GUIDELINES.md](BRAND_GUIDELINES.md).

## Status

The public repository includes a headless CLI with model routing and subagents, plus Web and desktop clients. The Web composition provides a session subagent tree with read-only monitoring, ledger statistics, node health and administration, and a read-only skills catalog. Seat orchestration and its UI are opt-in; installing the packages does not enable automatic opening. Separate private plugins also exist; they are not described here.

Planned next: public-release preparation, then long-running sessions and subagent supervision, then upstream-sync automation. See the [Panedesk architecture](docs/panedesk/architecture.md) for public composition and configuration.

## Platform behavior

The Windows row describes the intended safe default; its permission changes are not yet integrated into this checkout. Until they are integrated, explicitly set `PANEDESK_PERMISSION_MODE=read-only` on Windows to avoid the current workspace-write default. Windows native enforcement has not been validated on a Windows machine.

| Platform | Sandbox | Write access | Bash default | Known limitations |
| --- | --- | --- | --- | --- |
| Windows | Restricted token with low integrity and directory capability ACLs. | Target: without an explicit mode, read-only and no ACL changes. The first write in a workspace requests English/Chinese confirmation; allowing records consent and grants that directory write access. Settings can preauthorize or revoke a workspace. Unattended sessions do not prompt: they stay read-only and explain how to enable writes. Explicit modes remain effective. | Disabled without an environment or settings selection; PowerShell is the alternative. | Partial confinement: hard links, unrestricted reads, and AppContainer ACL constraints remain. Revocation does not terminate already-open processes or handles, but new tool calls become read-only immediately. The permission-mode selector does not immediately reflect directory records. These target behaviors are pending integration and Windows-machine validation. |
| Linux | bubblewrap (`bwrap`), with Landlock as fallback. | Defaults to workspace-write for workspace and temporary roots; explicit mode selection overrides it. | Enabled, using the configured Bash or `bash` on PATH. | No usable runner means refusal. Older Landlock ABIs may provide partial confinement; not every kernel configuration has been validated. |
| macOS | Seatbelt through `sandbox-exec`. | Defaults to workspace-write for workspace and temporary roots; explicit mode selection overrides it. | Enabled, using the configured Bash or `bash` on PATH. | Paths are normalized on the host. Seatbelt does not hide host processes; platform-injected regressions do not constitute native macOS validation. |

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
