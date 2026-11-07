# Changelog

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
