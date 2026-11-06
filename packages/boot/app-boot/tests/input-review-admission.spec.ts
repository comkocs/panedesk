/** Workspace write admission and agent reviews serialize without weakening direct verification. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'input-review-admission-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  const path = join(workspace, 'entry.js')
  writeFileSync(path, 'approved')
  const baseline = new ProtectedInputIntegrity(workspace, home)
  baseline.observe(path)
  await baseline.grantWrite()
  const reader = await ProtectedInputIntegrity.openOwnerRecordsAsync(workspace, home)
  return { reader, path, workspace }
}

it('prepares nested home authority parents before the first write baseline', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'input-review-home-'))
  onTestFinished(() => { rmSync(workspace, { recursive: true, force: true }) })
  const home = join(workspace, 'owner')
  mkdirSync(home)
  const path = join(home, 'cordis.patch.yml')
  writeFileSync(path, 'approved')
  const reader = new ProtectedInputIntegrity(workspace, home)
  reader.observe(home)
  await reader.ensureWrite([home])
  mkdirSync(join(home, 'storages/session_projcache/sessions'), { recursive: true, mode: 0o700 })
  expect(await reader.review({ blocked() {}, confirm: async () => false })).toBe(true)
  writeFileSync(path, 'unapproved')
  expect(await reader.review({ blocked() {}, confirm: async () => false })).toBe(false)
  expect(reader.readTrusted(path)?.toString()).toBe('approved')
})

it('serializes write admission with an agent review over an existing baseline', async () => {
  const { reader } = await fixture()
  const results = await Promise.allSettled([
    reader.ensureWrite(),
    reader.review({ blocked() {}, confirm: async () => false }),
  ])
  expect(results).toEqual([
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: true },
  ])
})

it('keeps a refused agent review and write admission denied without replacing trusted bytes', async () => {
  const { reader, path } = await fixture()
  writeFileSync(path, 'unapproved')
  const results = await Promise.allSettled([
    reader.ensureWrite(),
    reader.review({ blocked() {}, confirm: async () => false }),
  ])
  const admission = results[0]
  expect(admission?.status).toBe('rejected')
  if (admission?.status !== 'rejected') throw new Error('Changed input was admitted')
  const reason: unknown = admission.reason
  expect(reason).toHaveProperty('name', 'ProtectedInputReviewError')
  expect(results[1]).toEqual({ status: 'fulfilled', value: false })
  expect(reader.readTrusted(path)?.toString()).toBe('approved')
})

it('rejects queued reviews when their workspace generation is invalidated', async () => {
  const { reader, path, workspace } = await fixture()
  writeFileSync(path, 'unapproved')
  const entered = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<boolean>()
  const first = reader.review({ blocked() {}, confirm: async () => {
    entered.resolve(undefined)
    return answer.promise
  } })
  const second = reader.review({ blocked() {}, confirm: async () => true })
  const results = Promise.allSettled([first, second])
  try {
    await entered.promise
    reader.invalidateWorkspace(workspace)
  } finally { answer.resolve(false) }
  for (const result of await results) {
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') throw new Error('Invalidated review was accepted')
    const reason: unknown = result.reason
    expect(reason).toHaveProperty('message', 'Protected workspace generation was revoked or replaced')
  }
  expect(reader.readTrusted(path)?.toString()).toBe('approved')
})

it('continues reviewing after a failed queued request without accepting its changed bytes', async () => {
  const { reader, path } = await fixture()
  writeFileSync(path, 'unapproved')
  const failure = new Error('owner transport failed')
  const first = reader.review({ blocked() {}, confirm: async () => { throw failure } })
  const second = reader.review({ blocked() {}, confirm: async () => false })
  const results = await Promise.allSettled([first, second])
  expect(results[0]).toEqual({ status: 'rejected', reason: failure })
  expect(results[1]).toEqual({ status: 'fulfilled', value: false })
  expect(reader.readTrusted(path)?.toString()).toBe('approved')
})
