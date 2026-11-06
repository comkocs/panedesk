/** Full worker results stay private until restoration and authority checks finish. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as thread from '../src/input-review-thread.ts'
import { ProtectedInputIntegrity, type InputReviewState } from '../src/input-integrity.ts'

vi.mock('../src/input-review-thread.ts', async original => ({ ...await original<typeof import('../src/input-review-thread.ts')>() }))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'restore-review-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  mkdirSync(home)
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const empty: InputReviewState = { workspace, home, approved: [], observed: [], granted: false, owners: [] }
  vi.spyOn(thread, 'runInputReviewThread').mockResolvedValue(empty)
  return { workspace, home, empty }
}

function largeState(empty: InputReviewState, visit: (index: number) => void = () => {}): InputReviewState {
  const files = Array.from({ length: 12_000 }, (_, index) => ({
    get path() { visit(index); return join(empty.workspace, `file-${index}.js`) },
    content: Buffer.from(`entry-${index}`).toString('base64'),
  }))
  return { ...empty, granted: true, observed: [empty.workspace], approved: [[empty.workspace, {
    digest: 'a'.repeat(64), treeDigest: 'b'.repeat(64), kind: 'directory', target: empty.workspace,
    content: null, ancestors: [], files,
  }]] }
}

async function host() {
  const f = fixture()
  const reader = await ProtectedInputIntegrity.openOwnerRecordsAsync(f.workspace, f.home)
  onTestFinished(async () => { await reader.disposeReview() })
  const respond = (state: InputReviewState): void => {
    vi.mocked(thread.runInputReviewThread).mockImplementation(async () => ({
      accepted: true, cacheKey: reader.reviewIdentity(), state,
    }))
  }
  return { ...f, reader, respond }
}

it('bounds cold-result restoration work between event-loop timer callbacks', async () => {
  const f = await host()
  let clock = 0
  let previous = 0
  let maximum = 0
  let active = true
  // Each parsed path costs one deterministic work unit, independent of machine speed.
  // The 64-unit ceiling leaves eight times the production slice budget, not a heartbeat override.
  const state = largeState(f.empty, () => { clock++ })
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const sample = (): void => { maximum = Math.max(maximum, clock - previous); previous = clock }
  const timer = async (): Promise<void> => {
    while (active) { await immediate(); sample() }
  }
  const sampling = timer()
  f.respond(state)
  try { expect(await f.reader.review({ blocked() {}, confirm: async () => false })).toBe(true) }
  finally { active = false; await sampling }
  console.info(`restore maximum synchronous work units: ${maximum}`)
  expect(maximum).toBeLessThanOrEqual(64)
})

it('does not expose a startup reader or publish admission while restoring', async () => {
  const f = fixture()
  let returned = false
  let visits = 0
  vi.mocked(thread.runInputReviewThread).mockResolvedValue(largeState(f.empty, () => {
    visits++
    expect(returned).toBe(false)
  }))
  const reader = await ProtectedInputIntegrity.openOwnerRecordsAsync(f.workspace, f.home).then((value) => {
    returned = true
    return value
  })
  onTestFinished(async () => { await reader.disposeReview() })
  expect(visits).toBeGreaterThan(12_000)
  expect(reader.readTrusted(join(f.workspace, 'file-11999.js'))?.toString()).toBe('entry-11999')
})

it.each(['generation', 'roots', 'revision'] as const)('discards a cold result when %s changes during restoration', async (change) => {
  const f = await host()
  let changed = false
  const state = largeState(f.empty, (index) => {
    if (changed || index !== 6000) return
    changed = true
    if (change === 'generation') f.reader.invalidateWorkspace(f.workspace)
    else if (change === 'roots') f.reader.observe(join(f.workspace, 'later.js'))
    else {
      const directory = join(f.home, 'windows-workspace-write', 'protected-inputs')
      mkdirSync(directory, { recursive: true })
      // A competing durable revision must invalidate the outstanding worker result.
      writeFileSync(join(directory, `${createHash('sha256').update(f.workspace).digest('hex')}.json`), '{}')
    }
  })
  f.respond(state)
  const before = f.reader.exportReviewState()
  await expect(f.reader.ensureWrite()).rejects.toThrow()
  expect(f.reader.exportReviewState().approved).toEqual(before.approved)
  expect(f.reader.exportReviewState().granted).toBe(false)
})

it('keeps admission pending and the previous approved state visible throughout restoration', async () => {
  const f = await host()
  let published = false
  let visits = 0
  f.respond(largeState(f.empty, () => {
    visits++
    expect(published).toBe(false)
    const visible = f.reader.exportReviewState()
    expect(visible.approved).toEqual([])
    expect(visible.granted).toBe(false)
  }))
  await f.reader.ensureWrite().then(() => { published = true })
  expect(visits).toBeGreaterThan(12_000)
  expect(published).toBe(true)
  expect(f.reader.exportReviewState().approved.length).toBe(1)
})

it('refuses a mid-restoration exception without retaining partial approved copies', async () => {
  const f = await host()
  const state = largeState(f.empty, (index) => { if (index === 6000) throw new Error('restore interrupted') })
  f.respond(state)
  await expect(f.reader.ensureWrite()).rejects.toThrow('restore interrupted')
  expect(f.reader.exportReviewState()).toEqual(f.empty)
})

it('restores every exported field and indexed copy identically to the synchronous reader', async () => {
  const f = fixture()
  const state = largeState(f.empty)
  const expected = ProtectedInputIntegrity.fromReviewState(state)
  vi.mocked(thread.runInputReviewThread).mockResolvedValue(state)
  const actual = await ProtectedInputIntegrity.fromReviewState(state, () => {})
  onTestFinished(async () => { await actual.disposeReview() })
  expect(actual.exportReviewState()).toEqual(expected.exportReviewState())
  for (const index of [0, 6000, 11999]) {
    const path = join(f.workspace, `file-${index}.js`)
    expect(actual.readTrusted(path)).toEqual(expected.readTrusted(path))
  }
})
