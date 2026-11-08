# Changelog

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
