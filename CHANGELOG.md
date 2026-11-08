# Changelog

## 1.6.0

### Added

- An agent map button between the permission and model pickers opens a compact map of the session's subagents, expanding from the session in the middle, with background shell tasks in the corner. Selecting an agent shows its task and can open its session.
- The Database connections settings page stores PostgreSQL connections from a connection string or separate fields, with SSL, an optional SSH tunnel and a connection test. Passwords and key passphrases are kept in Panedesk credentials.
- Panedesk data can be stored in a saved PostgreSQL connection, in its own `panedesk` schema. Existing local data can be copied over, and Panedesk falls back to local storage when the database cannot be reached. Ledger rows are written there too and the statistics panel reads them.
- A saved connection can let the model query it through a built-in SQL tool that lists tables, describes columns and runs SQL.
- MCP servers configured for Claude Code in the project's `.mcp.json` and in `~/.claude.json` are loaded as well; Panedesk's own entries win on name clashes.

### Changed

- Completed agents in the agent map show a grey dot.

## 1.5.0

### Added

- The session header has a statistics button that opens charts of token use by model, daily usage and a subagent call timeline, filtered by project and session.
- Hovering a subagent in the header list shows its task: status, model, duration, tokens, a prompt summary and recent tool calls.
- Skills are also read from `.claude/skills` in the project and in the home directory; the Skills page lists every scanned directory with its path, status and skill count.
- Custom provider models get reasoning levels inferred from the model: GPT, o-series, Claude and Grok models offer low, medium, high and xhigh, defaulting to high; image and audio models offer none. Each model row shows its levels and can change them.
- New sessions are named from the folder of the path in the opening message, or from a chosen part of it, followed by the creation date; repeated names on the same day get (1), (2). Untitled sessions also show the date.

### Changed

- Panedesk settings pages share one layout: a description, the switch and its default, the configuration file path with an Open button, and the adjustable options. DSH settings pages each start with a one-line introduction.
- The external subagent registry setting has a file picker and an on/off switch.
- Node connections are off by default and are turned on from their settings page.
- Model discovery checks only the newest model of each family by default, comparing version numbers. Custom model APIs are listed first and DeepSeek last.
- Completed subagents show a grey dot instead of a green one.
- The subagent tree shows a session as idle when no turn is running, instead of always running.

### Fixed

- DeepSeek model discovery requested the wrong endpoint and failed with HTTP 404.
- Agent presets imported from `.claude/agents` failed to load in the installed app.
- The opening-name setting row was missing from the Panedesk features page.

### Removed

- The Inbox button and panel in the session header.

## 1.4.0

### Added

- The subagent tool can start a child on any model configured in Panedesk by model name, or by an agent type from `.claude/agents`, in new and existing sessions alike.
- Settings has a Panedesk features page. New sessions can be named from a chosen part of the opening message plus the local date (for example `UI Controls 11-8`); otherwise the automatic title gets the session's start date.
- The subagent tree can list subagents recorded in an external JSONL registry file set on the Panedesk features page; shell commands receive `CLAUDE_CODE_SESSION_ID`.
- Messages sent while the agent is running wait below the conversation and are delivered after the current tool step in the same turn; a queued message can be withdrawn or sent immediately.

### Changed

- The sidebar and running status show the Panedesk mark instead of the upstream whale.
- The sidebar's More menu is replaced by a Settings button; Feedback and Sign in are removed.
- Settings navigation shows General, Models, Panedesk and DSH; upstream pages are grouped under DSH and Panedesk pages under Panedesk. Clicking outside Settings no longer closes it.
- All models accept text, images and files by default; attachments are no longer blocked before sending, and model input types list text, image, file and audio.
- Adding a model API opens the custom API form first, and custom providers no longer ask for a Provider ID.

### Removed

- The subagent model selection setting, now unnecessary.

## 1.3.0

### Removed

- Panedesk's extra protection layers on top of upstream DSH are removed; file access, subprocess, seat, credential and session behavior follow upstream again.

### Added

- Subagents can be dispatched by the agent types defined under `.claude/agents`.
- Subagent reports include the child session id and the model actually used.
- Child processes receive `PANEDESK_ENTRYPOINT`.

### Changed

- File tool write errors name the step, the path and whether it was denied or a system call failed, in English and Chinese.
- New sessions default to workspace-write access on every platform, as upstream.

## 1.2.1

### Fixed

- Models added from recognition are now saved when creating a custom provider.
- Requests to non-Claude models through Anthropic Messages gateways carry session metadata even when no cache option is set.

## 1.2.0

### Added

- Model recognition keeps the latest two models of each family.
- Custom provider forms fetch available models automatically once the base URL and API key are filled in.
- DeepSeek providers support model discovery, and providers without discovery no longer show the discover button.
- The model recognition panel explains what was selected and how to add more.
- New sessions remember the permission preset you last picked.
- Session titles refresh from recent rounds as a conversation goes on.

### Changed

- Requests to non-Claude models through Anthropic Messages gateways carry Claude Code style session metadata, so gateway prompt caching can hit.
- The empty new-session page shows the Panedesk mark.

## 1.1.1

### Fixed

- Windows startup failed with EPERM fsync when relocating a legacy credentials file.
- Writing a new file on Windows failed with a sharing violation when a parent folder was open as another program's working directory; a file that is genuinely in use now reports which file to close.

## 1.1.0

### Added

- The first-run welcome page links to Settings → Models → Add model provider through “Use another provider”.
- Unsigned Windows installations check comkocs/panedesk GitHub Releases for updates and prompt before downloading and installing. Version 1.0 has no update source, so install 1.1 manually once.
- The inbox explains and logs when data directory permissions are too broad.

### Fixed

- Subagent presets reported as "Unknown agent preset" when validated in the same activation turn.
- Update prompts opened from the account row downloading without confirmation.

### Changed

- Updated known limitations to identify the inherited Agent Teams issue and remove resolved issues.
- The run-gates development script accepts `--base` and file arguments to skip checks unrelated to changed files.

## 1.0.0

### Added

- Panedesk and pdesk launchers with slim-by-default profiles, optional full compositions and interactive provider setup.
- Session ledgers, subagent monitoring, statistics, node administration and opt-in seat orchestration in the Web composition.
- Authenticated owner approval, protected credential storage and Linux connection-source admission.

### Changed

- Disabled telemetry and product analytics by default and separated Panedesk branding from upstream DeepSeek Harness.
- Anchored Linux file operations to directory descriptors and enabled the Windows experimental handle backend by default.
- Reduced repeated protected-root scans during startup and preserved approved input state across restarts.

### Known limitations

- Windows console sharing and incomplete network isolation require separate OS accounts for untrusted tasks and Web-based owner approval.
- macOS path-based writes and unverified native platform enforcement remain restricted; see [platform behavior](docs/user/platform-behavior.md#platform-behavior).
- Windows file replacement permissions need care; follow [known limitations](README.md#known-limitations).
- Windows native builds are not byte-for-byte reproducible; use distributed artifacts with their supplied checksums.
