/**
 * Check the fork-divergence ledger against the upstream import baseline, both ways.
 *
 * `scripts/panedesk/fork-divergences.json` lists the intended divergences from the upstream
 * source import. This checker compares committed trees only (the working tree is never
 * read) and fails when the ledger is incomplete or stale:
 *
 * 1. Uncovered (must be 0): every baseline path that HEAD modified, deleted, or renamed
 *    away must be covered by at least one ledger `match.paths` pattern. Baseline paths are
 *    upstream-original files; paths HEAD added are exempt from this direction.
 * 2. Expired (must be 0): every ledger pattern must still match at least one path that
 *    differs from the baseline, where a path added by HEAD differs by absence. A pattern
 *    matching nothing in either tree is a dead reference (for example a private-repository
 *    path) and is expired as well.
 *
 * `match.paths` uses the glob dialect the ledger has used since its first entry, shared
 * with the fork coverage probe: `*` matches within one path segment, `**` crosses segments
 * and a slash-delimited `**` may also span zero segments, `?` matches one character, and a
 * pattern without wildcards matches exactly that path. `match.type`, `match.test`,
 * `match.replacements`, and every other `match` field are ledger documentation; they never
 * change matching.
 *
 * Permission bits: a path whose blob is byte-identical to the baseline and differs only in
 * the executable mode bit is not a content divergence. The checker lists such paths in a
 * separate informational section; they need no ledger entry and never affect the exit
 * code. A ledger pattern whose only matches are mode-only differences is expired like any
 * other pattern that no longer tracks a divergence. The import commit itself differs from
 * the upstream tag only in permission bits, so content is the divergence signal.
 *
 * The baseline commit is configured in exactly one place, `UPSTREAM_BASELINE_COMMIT`.
 * An upstream sync moves the baseline by changing that constant alone.
 *
 * Usage: `pnpm exec tsx scripts/panedesk/check-fork-divergences.ts [--head REV]`
 * @module scripts/panedesk/check-fork-divergences
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Upstream source import this fork diverges from; the single baseline reference point. */
export const UPSTREAM_BASELINE_COMMIT = '1d0c2b43f64546a6457c84f7c018eaf47b186e6a'

/** One path of a committed tree with its mode bits and blob object id. */
export interface TreeEntry {
  readonly mode: string
  readonly oid: string
}

/** Committed tree as a path index; symlinks appear with their target blob id. */
export type TreeIndex = Map<string, TreeEntry>

/** The two-way divergence view between the baseline and HEAD the ledger is checked against. */
export interface DivergenceView {
  /** Baseline paths HEAD modified, deleted, or renamed away; the coverage direction scope. */
  readonly baselineSide: string[]
  /** Every path differing from the baseline, including paths HEAD added; the liveness scope. */
  readonly all: string[]
  /** Paths differing from the baseline only in the executable mode bit; informational. */
  readonly modeOnly: string[]
  /** Every path present in either tree; distinguishes dead references from settled paths. */
  readonly treeUnion: string[]
}

/** Ledger entry shape; `match` fields beyond `paths` are documentation only. */
export interface LedgerEntry {
  readonly id: string
  readonly match: { readonly paths?: readonly string[] }
}

/** A ledger pattern that no longer tracks any divergence. */
export interface ExpiredPattern {
  readonly entryId: string
  readonly pattern: string
  readonly reason: 'matches-no-tree-path' | 'matches-no-divergence'
}

/** Full check outcome; counts drive the exit code. */
export interface LedgerCheck {
  readonly uncovered: string[]
  readonly expired: ExpiredPattern[]
  readonly modeOnly: string[]
}

/** Parse `git ls-tree -r -z REV` output into a path index. */
export function parseTreeIndex(raw: Buffer): TreeIndex {
  const tree: TreeIndex = new Map()
  let start = 0
  while (start < raw.length) {
    const zero = raw.indexOf(0, start)
    const stop = zero === -1 ? raw.length : zero
    if (stop > start) {
      const record = raw.subarray(start, stop)
      const tab = record.indexOf(9)
      if (tab < 0) throw new Error('check-fork-divergences: ls-tree record without a path tab')
      const [mode, type, oid] = record.subarray(0, tab).toString('utf8').split(' ')
      const path = record.subarray(tab + 1).toString('utf8')
      if (type !== 'blob') throw new Error(`check-fork-divergences: non-blob tree entry for ${path}`)
      tree.set(path, { mode: mode as string, oid: oid as string })
    }
    start = stop + 1
  }
  return tree
}

/** Load a committed tree through git; fails loudly when REV is missing. */
export function loadTreeIndex(cwd: string, rev: string): TreeIndex {
  const raw = execFileSync('git', ['ls-tree', '-r', '-z', rev], { cwd, maxBuffer: 512 * 1024 * 1024 })
  return parseTreeIndex(raw)
}

/**
 * Compare the baseline tree with the HEAD tree and classify every path.
 * @param base - baseline tree index.
 * @param head - HEAD tree index.
 * @returns the divergence view the ledger is checked against.
 */
export function diffTrees(base: TreeIndex, head: TreeIndex): DivergenceView {
  const baselineSide: string[] = []
  const all: string[] = []
  const modeOnly: string[] = []
  const treeUnion: string[] = [...base.keys()]
  for (const [path, baseEntry] of base) {
    const headEntry = head.get(path)
    if (headEntry === undefined || headEntry.oid !== baseEntry.oid) {
      baselineSide.push(path)
      all.push(path)
    } else if (headEntry.mode !== baseEntry.mode) {
      modeOnly.push(path)
    }
  }
  for (const path of head.keys()) {
    if (!base.has(path)) {
      all.push(path)
      treeUnion.push(path)
    }
  }
  return { baselineSide, all, modeOnly, treeUnion }
}

/** Compile one ledger glob into the shared dialect; no wildcards means an exact path. */
export function compilePathPattern(pattern: string): RegExp {
  let source = ''
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i] as string
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 2
        if (pattern[i] === '/') {
          source += '(?:.*/)?'
          i += 1
        } else {
          source += '.*'
        }
        continue
      }
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    i += 1
  }
  return new RegExp(`^${source}$`)
}

/** Pattern set with an exact-path fast path; construction compiles every glob once. */
export class PathMatcher {
  private readonly exact: Set<string> = new Set()
  private readonly globs: { readonly pattern: string; readonly regex: RegExp }[] = []

  constructor(patterns: readonly string[]) {
    for (const pattern of patterns) {
      if (!/[*?]/.test(pattern)) this.exact.add(pattern)
      else this.globs.push({ pattern, regex: compilePathPattern(pattern) })
    }
  }

  /** Whether `path` is matched by any configured pattern. */
  matches(path: string): boolean {
    if (this.exact.has(path)) return true
    return this.globs.some(glob => glob.regex.test(path))
  }
}

/**
 * Check the ledger against a divergence view.
 * @param entries - ledger `divergences` array.
 * @param view - divergence view between the baseline and HEAD.
 * @returns uncovered baseline paths and expired ledger patterns with per-finding causes.
 */
export function checkLedger(entries: readonly LedgerEntry[], view: DivergenceView): LedgerCheck {
  const diverged = new Set(view.all)
  const coverage = new PathMatcher(entries.flatMap(entry => entry.match.paths ?? []))
  const uncovered = view.baselineSide.filter(path => !coverage.matches(path))
  const expired: ExpiredPattern[] = []
  const treePaths = new Set<string>(view.treeUnion)
  for (const entry of entries) {
    for (const pattern of entry.match.paths ?? []) {
      if (!/[*?]/.test(pattern)) {
        if (!diverged.has(pattern)) {
          expired.push({ entryId: entry.id, pattern, reason: treePaths.has(pattern) ? 'matches-no-divergence' : 'matches-no-tree-path' })
        }
        continue
      }
      const regex = compilePathPattern(pattern)
      if (!view.all.some(path => regex.test(path))) {
        const reason = view.treeUnion.some(path => regex.test(path)) ? 'matches-no-divergence' : 'matches-no-tree-path'
        expired.push({ entryId: entry.id, pattern, reason })
      }
    }
  }
  return { uncovered, expired, modeOnly: view.modeOnly }
}

function main(argv: readonly string[]): number {
  let head = 'HEAD'
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--head' && argv[i + 1] !== undefined) {
      head = argv[i + 1] as string
      i += 1
    } else {
      console.error(`check-fork-divergences: unknown argument ${JSON.stringify(argv[i])}; usage: --head REV`)
      return 2
    }
  }
  const root = resolve(import.meta.dirname, '../..')
  const ledgerPath = resolve(import.meta.dirname, 'fork-divergences.json')
  let entries: readonly LedgerEntry[]
  let headOid: string
  try {
    entries = (JSON.parse(readFileSync(ledgerPath, 'utf8')) as { divergences: LedgerEntry[] }).divergences
    headOid = execFileSync('git', ['rev-parse', '--verify', head], { cwd: root, encoding: 'utf8' }).trim()
  } catch (error) {
    console.error(`check-fork-divergences: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const view = diffTrees(loadTreeIndex(root, UPSTREAM_BASELINE_COMMIT), loadTreeIndex(root, headOid))
  const check = checkLedger(entries, view)
  console.log(`check-fork-divergences: baseline ${UPSTREAM_BASELINE_COMMIT.slice(0, 10)} vs HEAD ${headOid.slice(0, 10)}`)
  console.log(`check-fork-divergences: diverged baseline paths ${String(view.baselineSide.length)}, added ${String(view.all.length - view.baselineSide.length)}, mode-only ${String(view.modeOnly.length)} (informational)`)
  for (const path of check.uncovered) {
    console.log(`uncovered: ${path} — baseline path changed at HEAD and no ledger entry covers it`)
  }
  for (const finding of check.expired) {
    const cause = finding.reason === 'matches-no-tree-path'
      ? 'dead reference: matches no path in either tree'
      : 'registered path no longer differs from the baseline'
    console.log(`expired: ${finding.entryId} — pattern ${finding.pattern} ${cause}`)
  }
  console.log(`check-fork-divergences: uncovered ${String(check.uncovered.length)}, expired ${String(check.expired.length)}`)
  return check.uncovered.length === 0 && check.expired.length === 0 ? 0 : 1
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2))
}
