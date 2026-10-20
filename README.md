# Panedesk

English | [中文](README.zh.md)

**Panedesk** (Chinese name 窗台, "window sill") is an open-source, plugin-based coding-agent harness: one runtime for the agent loop, model routing, subagents, a session ledger, permissions and sandboxing. The name joins *pane* (each agent works in its own window) and *desk* (the ticket desk that will dispatch them).

> Built on DSH (DeepSeek Harness). Panedesk is an independent fork of [DSH](https://github.com/deepseek-ai/deepseek-harness) 0.2.1-rc.2 and is not affiliated with, endorsed by, or sponsored by DeepSeek. "DeepSeek Harness" is a registered trademark of DeepSeek; see [BRAND_GUIDELINES.md](BRAND_GUIDELINES.md).

## Status

Milestone 1 (slim base) is done: the fork builds, runs headless one-shot tasks against Anthropic Messages and OpenAI Chat Completions endpoints, and dispatches subagents. There is no Panedesk UI yet, and nothing is published to npm. Planned next: the automatic window (agent) launcher, ticket desk, workflow panel, a VS Code style dark UI, a subagent map tree, a cache layer with remaining-TTL display, and Claude Code style interjection and withdrawal.

Linux and macOS are the primary targets; Windows is supported for development.

## What changed from DSH

- **Slim by default.** The launcher depends on 9 packages instead of 86. The default `slim` preset mounts 39 plugin rows: the minimal headless core plus context compaction, large-output spill, the tool-call timeout guard and `AGENTS.md` loading.
- **Full on demand.** The `full` preset is the upstream DSH headless composition (98 rows). It, and the upstream `web`, `acp` and `sdk` profiles, become available when the `@panedesk/full` package is installed beside the launcher (it is in the development workspace).
- **Privacy off by default.** Session-log upload, plugin-inventory upload, session telemetry, anonymous identity headers and Desktop product analytics all default to off and can be switched on.
- **No brand opener.** The system prompt no longer starts with a "powered by" harness line.
- **Commands.** The CLI is `panedesk`, with the short name `pdesk`.
- Internal package names (`@deepseek-ai/dsh-*`), environment variables (`DSH_*`) and the home directory (`~/.dsh`) are unchanged for now; the rename list is in [docs/改名待改清单.md](docs/改名待改清单.md).

## Quick start from source

Requirements: Node.js `^22.19 || >=24`, pnpm 11 (via Corepack).

```sh
CI=true pnpm install            # CI=true skips installing upstream's git hooks
node_modules/.bin/tsx scripts/compile-referenced-projects.ts host-libraries
```

Pick a model provider. The slim preset defaults to pi-ai's `deepseek` route keyed by `DEEPSEEK_API_KEY`; any OpenAI-compatible or Anthropic Messages-compatible endpoint works through an overlay (templates in [examples/providers](examples/providers)), which references the key by environment-variable name only:

```sh
export MY_GATEWAY_API_KEY=...   # your own key
node apps/cli/lib/bin.js --patch examples/providers/openai-chat.yml "summarize this repository"
node apps/cli/lib/bin.js full "the same task on the full preset"
node apps/cli/lib/bin.js --help
```

Launcher flags (`--profile`, `--patch`, dumps) come before app flags such as `--json`. On Windows, prefer `DSH_PERMISSION_MODE=read-only` unless you want the sandbox to grant the workspace write access through directory ACLs.

## Presets

| Preset | How to run | What it mounts |
|---|---|---|
| `slim` (default) | `panedesk "task"` | 39 rows from `@panedesk/slim-base` + `@panedesk/slim-headless`: tools `read`, `write`, `edit`, `glob`, `grep`, `bash`/`pwsh`, `subagent` |
| `full` | `panedesk full "task"` | upstream `dsh-base` + `dsh-headless`, 98 rows (web tools, skills, goals, workflow, todo, jobs, …) |

`@panedesk/slim-base` is generated row-for-row from upstream `dsh-base` by `scripts/panedesk/gen-slim-base.ts`, so upstream fixes to shared rows carry over.

## License

MIT. The upstream notice `Copyright (c) 2026 DeepSeek` is kept and `Copyright (c) 2026 Panedesk contributors` is added; see [LICENSE](LICENSE). Third-party notices inherited from DSH are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
