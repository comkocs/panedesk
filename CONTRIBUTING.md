# Contributing

English | [中文](CONTRIBUTING.zh.md)

Panedesk is an independent fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with its own product identity and plugin compositions.

External pull requests to this repository are not currently accepted; you can share reproducible bug reports, publish plugins with the `dsh-plugin` topic, and help other users.

## Upstreaming fixes

1. Check whether the bug also affects upstream DeepSeek Harness and identify the smallest affected upstream component.
2. Extract a focused patch against upstream, excluding Panedesk branding, private integrations, local configuration and unrelated changes; use the [rename replay procedure](scripts/panedesk/rename/README.md) to translate package names where needed.
3. Include a minimal reproduction and relevant focused checks, then follow upstream's current contribution policy to propose a PR or report the fix if PRs are closed.
4. Record the local difference in `scripts/panedesk/fork-divergences.json` with a unique `id`, concise `description`, public `origin`, a `reason` stating upstream applicability and PR status, and `match.type` plus exact `match.paths` or existing-style globs.
5. When an upstream update includes the fix, replay it locally, remove only the obsolete divergence or patterns, and run the [ledger checker](scripts/panedesk/README.md#fork-divergence-ledger) so uncovered and expired counts both remain zero.
