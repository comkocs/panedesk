<div align="center">

# Panedesk

![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-blue) ![Version](https://img.shields.io/badge/version-2.0.11-blue) ![Node.js](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-green) ![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue) ![Electron](https://img.shields.io/badge/Electron-44-blue) ![MIT](https://img.shields.io/badge/license-MIT-green)

An open-source, plugin-based coding-agent workspace for CLI, Web and desktop.

English | [中文](README.zh.md)

</div>

## Get started

1. Download and run the latest Windows installer from this repository's [GitHub Releases](https://github.com/comkocs/panedesk/releases). The installer is unsigned; if SmartScreen warns you, select **More info → Run anyway**.
2. On first launch, enter a DeepSeek API Key on the welcome page, or select **Use another provider** to open **Settings → Models → Add model provider**.
3. Install private plugins, such as the ticket desk, through the plugin manager using the absolute package path.

Starting with 1.1, the app notifies you of updates; 1.0 users must manually install 1.1 once.

## Features

Model routing, subagents, a session ledger, permissions and sandboxing share one workspace. The default slim composition provides the core; full is available on demand, alongside provider configuration and plugin management. See [architecture and presets](docs/panedesk/architecture.md).

## Supported platforms

Windows provides a desktop EXE; Linux and macOS can run the CLI and Web from source. See [platform behavior and sandbox session isolation](docs/user/platform-behavior.md).

## Important notice

- Panedesk is an independent fork of [DSH](https://github.com/deepseek-ai/deepseek-harness) 0.2.1-rc.2, not affiliated with, endorsed by, or sponsored by DeepSeek; see [BRAND_GUIDELINES.md](BRAND_GUIDELINES.md) for the trademark notice.
- The Windows installer is unsigned; in-app updates connect only to this repository's Releases.
- Session telemetry and product analytics are off by default and can be enabled.

## Build from source

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm 11 via Corepack. From the repository root:

```sh
pnpm run setup
node apps/cli/lib/bin.js init
```

Configure a provider as prompted; run `node apps/cli/lib/bin.js --help` for CLI usage. For Web, run `pnpm run dev:web` and open the printed local address. Linux users should first read [platform behavior](docs/user/platform-behavior.md#platform-behavior).

## Known limitations

- Windows console sharing allows sandboxed commands to inject approval keystrokes; use the authenticated Web frontend in Edge rather than CLI/TUI approval.
- Sandbox networking does not isolate loopback or all abstract sockets, allowing access to local services; use a separate OS account without local-service credentials for untrusted workloads.
- Landlock-only hosts cannot hide named tmux, screen or D-Bus sockets that may execute outside the sandbox; run untrusted workloads under a separate account.
- macOS and Windows host-mediated launch channels remain unverified; do not expose privileged host automation to an untrusted workload account.
- Windows native sandbox enforcement and the desktop CLI launcher have not been validated on hardware; prefer the Web package and retain OS-account isolation.
- Windows desktop third-party platform cookies remain readable to low-integrity commands; keep sensitive platform accounts out of the desktop browser used with untrusted tasks.
- macOS Web cannot identify product-sandbox cookie replay; run untrusted processes under a separate account.
- Persistent PowerShell terminals under the Linux native sandbox may produce no output and time out; use Bash there instead.
- Plugin activation can lag installation under heavy load; wait for activation to finish before retrying or issuing plugin-dependent tasks.
- Unanswered ordinary approvals have no service-wide deadline and leave the turn waiting without writing; decide the request or cancel the turn.
- Web session creation or submission has occasionally stalled without a confirmed cause; if a turn stops progressing, check the session and host logs before restarting.
- Preset-heavy session scenarios have exhausted worker memory and ledger unavailability remains unexplained; reduce active presets and preserve logs if it occurs.
- Building optional integrations from non-ASCII paths can fail; use an ASCII-only source path.
- Passing a custom port through start.cmd leaves the printed link and polling on the default port; use the default port until argument forwarding is fixed.
- An open Windows file handle can block replacement; close the program holding the file and retry.
- Windows upgrade preparation can fail a directory rename with EPERM; close the previous host and retry preparation.
- First-start upgrade preparation has taken several minutes without progress detail; leave the console open and wait rather than starting another copy.
- Long extraction paths can exceed Windows path limits, especially with usernames longer than 20 characters; extract directly to a short path such as C:\panedesk\ without an extra nested folder.
- Windows native rebuilds are not byte-for-byte reproducible because of linker metadata; use the distributed artifacts and verify their supplied checksums.
- Reusing a build tree can include stale lib chunks in packages; package from a clean checkout or remove old lib output first.
- Stopping or upgrading the Windows launcher can leave a hidden polling PowerShell process; inspect and close only the polling process associated with that launch.
- Inherited from upstream DSH 0.2.1-rc.2: In Agent Teams mode a teammate session is occasionally not saved; rerun the team task if a teammate's history is missing.

## Differences from DSH

Slim is the default, full is available on demand, telemetry defaults to off, and the CLI commands are `panedesk` and `pdesk`. See [architecture](docs/panedesk/architecture.md) for composition, naming and configuration.

## License

MIT. The upstream notice `Copyright (c) 2026 DeepSeek` is kept and `Copyright (c) 2026 Panedesk contributors` is added; see [LICENSE](LICENSE). Third-party notices inherited from DSH are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

See the [contribution guide](CONTRIBUTING.md).
