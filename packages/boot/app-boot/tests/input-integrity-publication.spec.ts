/** Interleaved POSIX publication must not look like a hard link outside an authoritative tree. */
import { linkSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@panedesk/dsh-session'
import * as JsonlSessionPersistence from '@panedesk/dsh-session-persistence-jsonl'
import * as promises from 'node:fs/promises'
import * as fs from 'node:fs'
import { checkAuthoritativeTree } from '../src/input-integrity-structure.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

const trees = ['ledger', 'sessions', 'storages/session_projcache/sessions'] as const

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'authority-publication-'))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const roots = trees.map((tree) => {
    const root = join(home, tree)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    return root
  })
  return { home, roots }
}

it('accepts link-before-unlink publication interleaved with 3000 reviews of all three authoritative trees', () => {
  const { roots } = fixture()
  let refusals = 0
  let reviews = 0
  // Stop at the real cooperative traversal boundary after directory enumeration.
  // The host's no-clobber publication then adds a name absent from that enumeration;
  // directory durability can keep both names alive until after the review finishes.
  for (let round = 0; round < 3000; round++) {
    for (const root of roots) {
      const staged = join(root, '.session.new')
      const published = join(root, 'session.jsonl')
      writeFileSync(staged, 'host state\n', { mode: 0o600 })
      const review = checkAuthoritativeTree(root)
      expect(review.next().done).toBe(false)
      linkSync(staged, published)
      try {
        for (const _step of review) { /* Complete this review without restarting it. */ }
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Protected authoritative home tree')) throw error
        refusals++
      } finally {
        unlinkSync(staged)
        unlinkSync(published)
      }
      reviews++
    }
  }
  console.info(JSON.stringify({ rounds: 3000, reviews, refusals }))
  expect(reviews).toBe(9000)
  expect(refusals).toBe(0)
})

it('accepts 3000 real session publications while reviewing all three authoritative trees', async () => {
  const { roots } = fixture()
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { vi.restoreAllMocks() } })
  const root = roots[1]
  if (root === undefined) throw new Error('Missing sessions root')
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const original = promises.link
  const enumerate = fs.readdirSync
  let enumerated: string | undefined
  vi.spyOn(fs, 'readdirSync').mockImplementation((...args) => {
    enumerated = String(args[0])
    return enumerate(...args)
  })
  let publications = 0
  let refusals = 0
  let reviews = 0
  vi.spyOn(promises, 'link').mockImplementation(async (source, destination) => {
    const scans = roots.map(tree => checkAuthoritativeTree(tree))
    const sessionScan = scans[1]
    if (sessionScan === undefined) throw new Error('Missing sessions review')
    // Pause the real traversal after enumerating the writer's staging directory.
    // Neither filesystem result is mocked; only the concurrent schedule is fixed.
    enumerated = undefined
    while (enumerated !== dirname(String(destination))) {
      if (sessionScan.next().done) throw new Error('Staging directory was not reviewed')
    }
    await original(source, destination)
    for (const scan of scans) {
      try { for (const _step of scan) { /* Finish each review exactly once. */ } } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Protected authoritative home tree')) throw error
        refusals++
      }
      reviews++
    }
    publications++
  })
  for (let round = 0; round < 3000; round++) {
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: SessionId(`publication-${round}`), createdAt: round, isSeeded: false,
    })
    try { await handle.flush() } finally { await handle.close() }
    // Retain a bounded tree; removing test-owned completed sessions is not a retry.
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { mode: 0o700 })
  }
  console.info(JSON.stringify({ publications, reviews, refusals }))
  expect(publications).toBe(3000)
  expect(reviews).toBe(9000)
  expect(refusals).toBe(0)
})

it.each(trees)('rejects a persistent outside hard link during publication in %s', (tree) => {
  const { home } = fixture()
  const root = join(home, tree)
  const staged = join(root, '.session.new')
  const published = join(root, 'session.jsonl')
  const outside = join(home, 'outside')
  writeFileSync(staged, 'host state\n', { mode: 0o600 })
  linkSync(staged, outside)
  const review = checkAuthoritativeTree(root)
  expect(review.next().done).toBe(false)
  linkSync(staged, published)
  expect(() => [...review]).toThrow('Protected authoritative home tree')
  unlinkSync(staged)
  expect(() => [...checkAuthoritativeTree(root)]).toThrow('Protected authoritative home tree')
})
