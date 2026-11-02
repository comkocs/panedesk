# Panedesk release scripts

English | [中文](release.zh.md)

Reference for the npm release scripts in the root [package.json](../../package.json). The local rehearsal entry is `release:check`; the inherited version-bump and publishing commands are not part of that rehearsal. Desktop packaging and upload commands are separate from the npm release chain.

## Local rehearsal

`release:check` verifies and packs the DSH release family, scans the tarballs, runs `npm publish --dry-run` against the public registry, and queries package names. It never publishes a package or creates a release. Prepare the native addon and official build artifacts first; a normal development build does not satisfy every official artifact check. Run from the repository root with a new output directory whose parent already exists:

```sh
pnpm run build:native-system
pnpm run build:artifacts --profile official
pnpm run release:check --out ./release-rehearsal
```

The output directory contains tarballs, per-step logs, and `report.json`. The report separates first-party executable code, first-party documentation, and vendored third-party text, and applies the checked-in [scan exemptions](../../scripts/panedesk/release-check-exemptions.json). A successful dry-run or an npm name query does not prove publication rights; `pdesk` is a bin alias of the `panedesk` package, not a second launcher package, and a scoped namespace needs organization setup before publication.

Packed-install verification runs only when supplementary vendor and native tarball directories are supplied with repeatable `--from` arguments. Without them, the report explicitly records that packed installation did not run. The Linux rehearsal has passed tarball scans and npm dry-runs, but packed-install verification remains blocked on a host without CMake: its `--omit=optional` install omits the optional Koffi platform binary and then attempts a source build. Use a host with the required native build tools to complete that check; do not treat a dry-run as installed-package validation.

## Script reference

“In use” means the local rehearsal invokes the script, including the optional packed-install step. “Upstream legacy” means the inherited command remains available but is not selected by the local rehearsal; it does not mean the implementation is broken or unused by inherited workflows.

| Script | Status | Can it be used? | Behavior and limits |
| --- | --- | --- | --- |
| `release:check` | In use | Yes, for local dry-runs after the official build. | Verifies, packs, scans, and runs npm dry-runs; requires a new `--out` directory and registry access. Calls packed-install only with `--from`; never publishes. |
| `release:verify` | In use | Yes, for read-only release-family validation. | Checks versions and publication order; `RELEASE_PUBLISH=true` additionally enables publishability and tag checks. The rehearsal does not enable publication mode. |
| `release:pack` | In use | Yes, with built artifacts and an owned output directory. | Packs and validates the selected family. A direct invocation deletes and recreates its `--out` directory; the rehearsal uses its own tarball subdirectory. |
| `release:verify-packed-install` | In use | Conditional; needs complete DSH, vendor, and native tarballs plus native build prerequisites. | Installs into an isolated consumer and checks the installed executable. Optional in `release:check`; the Linux Koffi/CMake blocker above is not a passing result. |
| `release:dsh` | Upstream legacy | Only for a deliberate version change, not a readiness check. | Bumps the shared DSH release version, updates the lockfile, and creates a Git commit; supports `--dry-run`. Not called by `release:check`. |
| `release:vendor` | Upstream legacy | Only for a deliberate vendor version change. | Bumps selected vendored package versions, updates the lockfile, and creates a Git commit; supports `--dry-run`. Not called by `release:check`. |
| `release:publish` | Upstream legacy | Only with explicit publication authorization, release inputs, and credentials. | Publishes supplied tarballs to npm with version and integrity checks. This is a real publisher, not a dry-run, and `release:check` never calls it. |
| `publish:npm-baseline` | Upstream legacy | Not a public-registry rehearsal entry. | Independent commit-addressed build, pack, install, and verification workflow with an internal-registry default. Its `release` and `publish` subcommands really publish; `release:check` never calls it. |

For preset composition and provider configuration, see the [Panedesk architecture](architecture.md). For inherited release-family mechanics, see [npm release sequences](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md).
