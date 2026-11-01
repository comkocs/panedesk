# Panedesk fork maintenance scripts

English | [中文](README.zh.md)

Fork-owned scripts under `scripts/panedesk/` keep the Panedesk divergence from the
upstream DeepSeek Harness source checkable and replayable. The upstream import
baseline is the repository's root commit, the "Import DSH 0.2.1-rc.2 source"
import. `check-fork-divergences.ts` resolves that root commit from the history at
run time — the single place the baseline is identified, so maintained sources
spell out no commit hash.

## Fork divergence ledger

```sh
pnpm exec tsx scripts/panedesk/check-fork-divergences.ts [--head REV]
```

`check-fork-divergences.ts` checks `fork-divergences.json` against the baseline both
ways and fails with a per-path and per-entry list when either direction is nonzero:

- Uncovered (must be 0): every baseline path that HEAD modified, deleted, or renamed
  away is covered by at least one ledger `match.paths` pattern. When a change to an
  upstream-original file turns this check red, add the path to the entry that owns
  the divergence, or add a new entry in the existing style, in the same change.
- Expired (must be 0): every ledger pattern still matches at least one path that
  differs from the baseline, where a path HEAD added differs by absence. A pattern
  that matches no path in either tree is a dead reference and is expired as well.

`match.paths` uses `*` within one path segment, `**` across segments (a
slash-delimited `**` may span zero segments), and `?` for one character; a pattern
without wildcards matches exactly that path. `type`, `test`, `replacements`, and the
other `match` fields document the divergence for humans and never change matching.

### Permission bits

A path whose bytes are identical to the baseline and that differs only in the
executable mode bit is not a content divergence. The checker reports these paths in
a separate informational section; they need no ledger entry and never affect the
exit code. A ledger pattern whose only matches are mode-only differences is expired
like any other pattern that no longer tracks a divergence. The import commit itself
differs from the upstream tag only in permission bits, so file content is the
divergence signal.

### Baseline moves

An upstream sync moves the baseline by making the new import the repository root; the
run-time root resolution in `check-fork-divergences.ts` stays the single place the
baseline is identified. Settle both directions again after the move: baseline paths
the sync made identical drop out of the divergence scope (remove their expired
entries), and paths the sync diverged need entries.

## Pending rename and slim-base freshness

The static CI lane also requires a zero pending count from the replayable rename and
an up-to-date generated slim-base bundle:

```sh
node scripts/panedesk/rename/rename.mjs --check
pnpm exec tsx scripts/panedesk/gen-slim-base.ts --check
```

See [rename/README.md](rename/README.md) for the rename mapping and patch replay.
