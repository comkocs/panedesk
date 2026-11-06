/** Repeated host reviews retain the isolate without repeating whole-reader transfers. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

const children = vi.hoisted(() => ({ count: 0, processes: [] as ChildProcess[] }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: (...args: Parameters<typeof actual.fork>) => {
    children.count++
    const child = actual.fork(...args)
    children.processes.push(child)
    return child
  } }
})

it('imports one complete reader for three sequential reviews in the same host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resident-review-'))
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
  onTestFinished(async () => { await reader.disposeReview() })
  const exports = vi.spyOn(reader, 'exportReviewState')
  const imports = vi.spyOn(ProtectedInputIntegrity, 'fromReviewState')
  children.count = 0
  const counts: number[][] = []
  for (let index = 0; index < 3; index++) {
    expect(await reader.review({ blocked() {}, confirm: async () => false })).toBe(true)
    counts.push([exports.mock.calls.length, children.count, imports.mock.calls.length])
  }
  expect(counts).toEqual([[1, 1, 1], [1, 1, 1], [1, 1, 1]])
  const child = children.processes.at(-1)
  if (child === undefined) throw new Error('Missing owned review process')
  await new Promise<void>((resolve) => { child.once('exit', () => { resolve() }); child.kill('SIGKILL') })
  expect(await reader.review({ blocked() {}, confirm: async () => false })).toBe(true)
  expect([exports.mock.calls.length, children.count, imports.mock.calls.length]).toEqual([2, 2, 2])
  const restarted = children.processes.at(-1)
  if (restarted === undefined) throw new Error('Missing replacement review process')
  const late = reader.review({ blocked() {}, confirm: async () => false })
  restarted.once('message', () => {
    restarted.emit('message', { kind: 'result', requestId: 'old-request', result: { accepted: true } })
  })
  await expect(late).rejects.toThrow('Invalid protected input worker response')
  expect(await reader.review({ blocked() {}, confirm: async () => false })).toBe(true)
  reader.invalidateWorkspace(workspace)
  expect(await reader.review({ blocked() {}, confirm: async () => false })).toBe(true)
  expect([exports.mock.calls.length, children.count, imports.mock.calls.length]).toEqual([4, 4, 4])
  writeFileSync(path, 'changed')
  expect(await reader.review({ blocked() {}, confirm: async () => false })).toBe(false)
  expect(reader.readTrusted(path)?.toString()).toBe('approved')
  const confirming = Promise.withResolvers<undefined>()
  const active = reader.review({ blocked() {}, confirm: () => { confirming.resolve(undefined); return new Promise<boolean>(() => {}) } })
  const activeRejected = expect(active).rejects.toThrow('disposed')
  const queued = reader.review({ blocked() {}, confirm: async () => true })
  const queuedRejected = expect(queued).rejects.toThrow('generation was revoked or replaced')
  await confirming.promise
  await reader.disposeReview()
  await Promise.all([activeRejected, queuedRejected])
  expect(children.processes.every(process => process.exitCode !== null || process.signalCode !== null)).toBe(true)
})
