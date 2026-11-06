/** Startup reviews report real progress and refuse stalled work without a total deadline. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as reviewThread from '../src/input-review-thread.ts'

vi.mock('../src/input-review-thread.ts', async original => ({ ...await original<typeof import('../src/input-review-thread.ts')>() }))
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'input-review-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  mkdirSync(join(home, 'windows-workspace-write'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'windows-workspace-write', 'input-review.json'), JSON.stringify({ stallTimeoutMs: 100 }), { mode: 0o600 })
  return { workspace, home }
}

it('offers isolated startup review before parsing protected launch inputs', async () => {
  const f = fixture()
  expect(ProtectedInputIntegrity).toHaveProperty('openOwnerRecordsAsync')
  const events: string[] = []
  const reader = await ProtectedInputIntegrity.openOwnerRecordsAsync(f.workspace, f.home, message => events.push(message))
  expect(reader).toBeInstanceOf(ProtectedInputIntegrity)
  expect(events.some(message => message.includes('Reviewing') && message.includes('复核'))).toBe(true)
  expect(events[0]).toContain('Panedesk starting')
  expect(events.findIndex(message => message.includes('Reviewing'))).toBeGreaterThan(0)
})

it('delivers owner state larger than one IPC write before the child disconnects', async () => {
  const f = fixture()
  rmSync(join(f.home, 'windows-workspace-write', 'input-review.json'))
  const path = join(f.workspace, 'large.js')
  writeFileSync(path, 'export const value = 1\n'.repeat(10_000))
  const baseline = new ProtectedInputIntegrity(f.workspace, f.home)
  baseline.observe(path)
  await baseline.grantWrite()
  const reader = await ProtectedInputIntegrity.openOwnerRecordsAsync(f.workspace, f.home)
  expect(reader.readTrusted(path)?.length).toBeGreaterThan(200_000)
  expect(await reader.verify({ blocked() {}, confirm: () => Promise.resolve(false) })).toBe(true)
})

it('does not replace a grant created by another host after isolated opening', async () => {
  const f = fixture()
  const path = join(f.workspace, 'entry.js')
  writeFileSync(path, 'approved')
  const reader = await ProtectedInputIntegrity.openOwnerRecordsAsync(f.workspace, f.home)
  reader.observe(path)
  const other = new ProtectedInputIntegrity(f.workspace, f.home)
  other.observe(path)
  await other.grantWrite()
  writeFileSync(path, 'changed')
  await expect(reader.ensureWrite()).rejects.toThrow('requires owner confirmation')
})

it('rejects a worker result that omits a newly observed other-owner input', async () => {
  const f = fixture()
  const otherWorkspace = join(dirname(f.workspace), 'other')
  mkdirSync(otherWorkspace)
  const first = join(otherWorkspace, 'first.js')
  const later = join(otherWorkspace, 'later.js')
  writeFileSync(first, 'first')
  writeFileSync(later, 'later')
  const other = new ProtectedInputIntegrity(otherWorkspace, f.home)
  other.observe(first)
  await other.grantWrite()
  const reader = await ProtectedInputIntegrity.openOwnerRecordsAsync(f.workspace, f.home)
  const run = reviewThread.runInputReviewThread
  vi.spyOn(reviewThread, 'runInputReviewThread').mockImplementation(async (...args) => {
    const result = await run(...args)
    reader.observe(later)
    return result
  })
  await expect(reader.verify({ blocked() {}, confirm: () => Promise.resolve(false) }))
    .rejects.toThrow('registered during capture')
})
