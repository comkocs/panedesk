/**
 * Panedesk fork check: the divergence ledger checker must flag both counterexample
 * shapes from the acceptance criteria — an unregistered upstream-file change and a
 * registered entry that no longer diverges — and must keep permission-bit noise,
 * fork-added paths, and dead references on their documented sides of the line.
 */

import { describe, expect, it } from 'vitest'
import { checkLedger, compilePathPattern, diffTrees, resolveBaselineCommit } from './check-fork-divergences.ts'
import type { LedgerEntry, TreeIndex } from './check-fork-divergences.ts'

function tree(entries: Record<string, string>): TreeIndex {
  return new Map(Object.entries(entries).map(([path, oid]) => [path, { mode: '100644', oid }]))
}

const baseline = tree({
  'packages/demo/src/index.ts': 'oid-a',
  'packages/demo/src/kept.ts': 'oid-b',
  'packages/demo/src/reverted.ts': 'oid-c',
  'packages/demo/old.ts': 'oid-d',
})

describe('diffTrees', () => {
  it('classifies modified, deleted, added, and mode-only paths against the baseline', () => {
    const head = new Map(baseline)
    head.set('packages/demo/src/index.ts', { mode: '100644', oid: 'oid-a2' })
    head.delete('packages/demo/old.ts')
    head.set('packages/demo/src/kept.ts', { mode: '100755', oid: 'oid-b' })
    head.set('packages/demo/src/fork-added.ts', { mode: '100644', oid: 'oid-new' })
    const view = diffTrees(baseline, head)
    expect(view.baselineSide).toEqual(['packages/demo/src/index.ts', 'packages/demo/old.ts'])
    expect(view.all).toEqual(['packages/demo/src/index.ts', 'packages/demo/old.ts', 'packages/demo/src/fork-added.ts'])
    expect(view.modeOnly).toEqual(['packages/demo/src/kept.ts'])
  })
})

describe('compilePathPattern', () => {
  it('compiles the ledger glob dialect', () => {
    expect(compilePathPattern('snapshots/*/*.expected.md').test('snapshots/web/ui.expected.md')).toBe(true)
    expect(compilePathPattern('snapshots/*/*.expected.md').test('snapshots/web/nested/ui.expected.md')).toBe(false)
    expect(compilePathPattern('docs/**/README.md').test('docs/README.md')).toBe(true)
    expect(compilePathPattern('docs/**/README.md').test('docs/a/b/README.md')).toBe(true)
    expect(compilePathPattern('a?.ts').test('ab.ts')).toBe(true)
    expect(compilePathPattern('a?.ts').test('a/.ts')).toBe(false)
    expect(compilePathPattern('a+b.ts').test('a+b.ts')).toBe(true)
    expect(compilePathPattern('a+b.ts').test('aabts')).toBe(false)
  })
})

describe('checkLedger acceptance counterexamples', () => {
  const changedHead = new Map(baseline)
  changedHead.set('packages/demo/src/index.ts', { mode: '100644', oid: 'oid-a2' })
  const changedView = diffTrees(baseline, changedHead)
  const coveringEntry: LedgerEntry = { id: 'demo-divergence', match: { paths: ['packages/demo/src/index.ts'] } }

  it('flags an unregistered upstream-file change and passes once the ledger covers it', () => {
    expect(checkLedger([], changedView).uncovered).toEqual(['packages/demo/src/index.ts'])
    const covered = checkLedger([coveringEntry], changedView)
    expect(covered.uncovered).toEqual([])
    expect(covered.expired).toEqual([])
  })

  it('flags a registered entry whose path no longer differs from the baseline', () => {
    const identicalView = diffTrees(baseline, new Map(baseline))
    const check = checkLedger([coveringEntry], identicalView)
    expect(check.uncovered).toEqual([])
    expect(check.expired).toEqual([
      { entryId: 'demo-divergence', pattern: 'packages/demo/src/index.ts', reason: 'matches-no-divergence' },
    ])
  })
})

describe('checkLedger boundary semantics', () => {
  const head = new Map(baseline)
  head.set('packages/demo/src/fork-added.ts', { mode: '100644', oid: 'oid-new' })
  head.set('packages/demo/src/index.ts', { mode: '100644', oid: 'oid-a2' })
  const view = diffTrees(baseline, head)

  it('keeps fork-added paths exempt from coverage but alive for pattern liveness', () => {
    const addedOnly: LedgerEntry = { id: 'fork-added-file', match: { paths: ['packages/demo/src/fork-added.ts'] } }
    const check = checkLedger([addedOnly], view)
    expect(check.uncovered).toEqual(['packages/demo/src/index.ts'])
    expect(check.expired).toEqual([])
  })

  it('reports dead references, for example private-repository paths, as expired', () => {
    const privatePath: LedgerEntry = { id: 'private-side', match: { paths: ['bundles/private/only.ts'] } }
    const check = checkLedger([privatePath], view)
    expect(check.expired).toEqual([
      { entryId: 'private-side', pattern: 'bundles/private/only.ts', reason: 'matches-no-tree-path' },
    ])
  })

  it('keeps mode-only differences out of the divergence scope', () => {
    const modeHead = new Map(baseline)
    modeHead.set('packages/demo/src/kept.ts', { mode: '100755', oid: 'oid-b' })
    const modeView = diffTrees(baseline, modeHead)
    const modeEntry: LedgerEntry = { id: 'mode-only-claim', match: { paths: ['packages/demo/src/kept.ts'] } }
    const check = checkLedger([modeEntry], modeView)
    expect(check.uncovered).toEqual([])
    expect(check.modeOnly).toEqual(['packages/demo/src/kept.ts'])
    expect(check.expired).toEqual([
      { entryId: 'mode-only-claim', pattern: 'packages/demo/src/kept.ts', reason: 'matches-no-divergence' },
    ])
  })
})

describe('ledger invariants', () => {
  it('resolves the upstream import baseline as the unique root commit and loads a ledger with unique ids', async () => {
    const { readFileSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')
    const path = await import('node:path')
    const root = path.resolve(import.meta.dirname, '../..')
    const baseline = resolveBaselineCommit(root)
    expect(baseline).toMatch(/^[0-9a-f]{40}$/)
    expect(baseline).toBe(execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim())
    const ledger = JSON.parse(readFileSync(new URL('./fork-divergences.json', import.meta.url), 'utf8')) as {
      divergences: LedgerEntry[]
    }
    expect(ledger.divergences.length).toBeGreaterThan(0)
    const ids = ledger.divergences.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of ledger.divergences) {
      expect(Array.isArray(entry.match.paths)).toBe(true)
    }
  })
})
