# Replayable Panedesk rename

English | [中文](README.zh.md)

Run from the repository root with Node.js 24; no installed dependencies are needed.

```sh
node scripts/panedesk/rename/rename.mjs --check
node scripts/panedesk/rename/rename.mjs --apply
node scripts/panedesk/rename/rename.mjs --patch upstream.diff panedesk.diff
```

`mapping.json` applies A (npm package identities), B (home paths), C (selected user
variables), then D (exact runtime product literals). Each rule has a stable ID and
an English description. A3 also covers scope-derived names without a slash, while
B2 excludes optional and computed property access (`?.dsh`, `).dsh`, `].dsh`).
B2 also skips documentation-site selectors in `website/.vitepress/**`, `website/tests/**` and all `*.css` files, and preserves `.dsh-build-preview` domains.
A4 updates scope-derived package anchors, template placeholders and matching
assertions; the standalone launcher slug becomes `panedesk`.
D counts describe the original input tree, after earlier
rules have run. `--apply` validates all of those counts before writing anything;
count drift aborts instead of silently accepting an upstream change. Applying the
same rename twice therefore fails deliberately. `--check` only prints pending
match counts and exits nonzero when anything remains; it never enforces baseline
counts or writes files.

Tree mode reads `git ls-files` and treats every strictly decodable UTF-8 file as
text, including files containing NUL bytes. UTF-8 decoding preserves any existing
BOM; encoding preserves all untouched bytes, including NUL and line endings.
It skips symlinks, invalid UTF-8 files, this tool's own directory, licenses, brand
guidelines, frozen agent notes under `.agents/notes/archived/` and the private rename checklist.
`mapping.json` lists preserved lines by path and required text fragment; `--apply`, `--check` and `--patch` leave those lines unchanged so the two root README explanations retain the legacy names they explicitly reject.
LibreOffice's externally published packages (including split path arguments) stay
in their original scope. Provider headers, provider identities, Python package and
module names, and upstream repository URLs are not product rename targets.
DeepSeek platform account, API Key, balance, and credit billing wording belongs to the model provider and is intentionally not renamed.
`APP_IDENTITY.url` remains the upstream URL because its existing interface requires
it. No compatibility reads of the old home or selected variables are introduced.

After the substitutions, tree mode runs the repository's
`scripts/gen-tsconfig-paths.ts` directly with Node to regenerate path aliases,
then `scripts/gen-dependency-catalog.ts` to sort the dependency catalog from its
recorded npm resolution. Both generators run offline without installed dependencies;
the catalog command does not refresh the resolution or its recorded metadata.
CLI help invocation literals and generated titles are mapped, but CLI help documents
are not regenerated.
`pnpm-lock.yaml` receives text substitutions only: this dependency-free tool does
not attempt to reserialize YAML or resolve packages. Verify it with
`CI=true pnpm install --frozen-lockfile`. Generator outputs and substitutions roll back
if either generator fails. After content substitutions, tree mode moves each tracked
file whose directory segments contain exactly `.dsh` to the corresponding
`.panedesk` path with `git mv`; filenames and legacy-home import code are not
rewritten by this path rule. This complements B1/B2's content substitutions.
`--check` lists each pending move as `B2-path` and reports its count. An already
content-renamed tree with only pending path moves skips D baseline validation and
generators; all other applications retain the original count validation.

## Replay a rename commit

Check out the script-only commit in a separate detached worktree, run `--apply`,
and compare the result against the generated rename commit. Do not compare against
later commits that adapt release logic, launcher help or build failures manually.

```sh
git worktree add --detach /path/to/replay SCRIPT_COMMIT
cd /path/to/replay
node scripts/panedesk/rename/rename.mjs --apply
git diff --stat RENAME_COMMIT
git diff --exit-code RENAME_COMMIT
# Align only the detached worktree's index and HEAD after proving byte equality.
# This preserves generated working files and makes porcelain status meaningful.
git reset --mixed RENAME_COMMIT
git status --porcelain
cd /path/to/original
git worktree remove /path/to/replay
```

## Upstream patches

Export an upstream change as a unified text diff, pass it through `--patch`, then
review and apply the transformed diff with `git apply --check` and `git apply`.
Patch mode rewrites file headers, added/deleted lines and context using the same
rules, without enforcing D's whole-tree counts or running generators. It preserves
line counts and hunk coordinates. Binary patch payloads are not rewritten; quoted
Git paths are rejected rather than guessed. Review patches that rename files or
introduce brand-new product literals. A new upstream baseline requires reviewing
D's expected counts, not automatically accepting new counts. Patch mode does not
include the separate manual release-logic and launcher-help commits.
