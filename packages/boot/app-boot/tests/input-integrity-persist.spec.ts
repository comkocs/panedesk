/** Persistence yields without publishing an incomplete or obsolete workspace grant. */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

function fixture(large = false) {
  const root = fs.mkdtempSync(join(tmpdir(), 'input-persist-'))
  onTestFinished(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'project')
  const home = join(root, 'owner')
  fs.mkdirSync(workspace)
  const path = join(workspace, 'entry.js')
  fs.writeFileSync(path, 'export const value = 1')
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(path)
  // Repeat captured descriptors, not filesystem work: the regression isolates record encoding.
  const capture = integrity['capture'].bind(integrity)
  integrity['capture'] = function* (...args: Parameters<typeof capture>) {
    const value = yield* capture(...args)
    if (large) value.files = Array.from({ length: 44_700 }, () => ({ path, blob: 'a'.repeat(64) }))
    return value
  }
  const record = join(home, 'windows-workspace-write', 'protected-inputs',
    `${createHash('sha256').update(fs.realpathSync(workspace)).digest('hex')}.json`)
  return { root, workspace, path, integrity, record }
}

function onRecordWrite(record: string, opened: () => void) {
  const original = fs.openSync
  let descriptor = -1
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    const result = original(...args)
    if (String(args[0]).startsWith(`${record}.`) && String(args[0]).endsWith('.new')) {
      descriptor = result
      opened()
    }
    return result
  })
  return (fd: number) => fd === descriptor
}

it('bounds event-loop stalls while encoding a large captured record', async () => {
  const f = fixture(true)
  let last = 0
  let maximum = 0
  let writes = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const tick = () => {
    const now = performance.now()
    maximum = Math.max(maximum, now - last)
    last = now
  }
  const isRecord = onRecordWrite(f.record, () => {
    last = performance.now()
    timer = setInterval(tick, 1)
  })
  const write = fs.writeSync
  vi.spyOn(fs, 'writeSync').mockImplementation((...args) => {
    if (isRecord(args[0]) && ++writes % 512 === 0) {
      // At least 348ms of controlled work separates an unbroken loop from 8ms slices.
      const until = performance.now() + 4
      while (performance.now() < until) { /* Fixed synthetic encoder cost. */ }
    }
    return write(...args)
  })
  try {
    await f.integrity.grantWrite()
    tick()
    console.info(JSON.stringify({ recordEntries: 44_700, maximumBlockMs: maximum, writes }))
    // 100ms leaves scheduling headroom without accepting the injected synchronous baseline.
    expect(maximum).toBeLessThan(100)
  } finally { clearInterval(timer) }
})

it('services a new event-loop request during persistence before granting write access', async () => {
  const f = fixture(true)
  let published = false
  let servicedBeforePublication = false
  let request: Promise<void> | undefined
  onRecordWrite(f.record, () => {
    request = setImmediate().then(() => {
      servicedBeforePublication = !published && !f.integrity.covers(f.path) && !fs.existsSync(f.record)
    })
  })
  await f.integrity.grantWrite().then(() => { published = true })
  await request
  expect(servicedBeforePublication).toBe(true)
  expect(f.integrity.covers(f.path)).toBe(true)
})

it('rejects a generation revoked while persistence is yielding before rename', async () => {
  const f = fixture(true)
  let request: Promise<void> | undefined
  onRecordWrite(f.record, () => { request = setImmediate().then(() => { f.integrity.invalidateWorkspace(f.workspace) }) })
  const result = await f.integrity.grantWrite().then(() => 'published', (error: unknown) => String(error))
  await request
  expect(result).toContain('generation was revoked or replaced')
  expect(fs.existsSync(f.record)).toBe(false)
  expect(f.integrity.covers(f.path)).toBe(false)
})

it.each(['worker failed', 'Protected input review stalled'])('keeps trust unpublished when the host commit refuses: %s', async (reason) => {
  const f = fixture()
  const commit = Promise.withResolvers<string | undefined>()
  const prepared = Promise.withResolvers<undefined>()
  f.integrity.setReviewCommit(() => { prepared.resolve(undefined); return commit.promise })
  const pending = f.integrity.grantWrite()
  const rejected = expect(pending).rejects.toThrow(reason)
  await prepared.promise
  expect(f.integrity.covers(f.path)).toBe(false)
  expect(fs.existsSync(f.record)).toBe(false)
  commit.reject(new Error(reason))
  await rejected
  expect(f.integrity.covers(f.path)).toBe(false)
  expect(fs.existsSync(`${f.record}.lock`)).toBe(false)
  expect(fs.readdirSync(join(f.record, '..')).filter(name => name.endsWith('.new'))).toEqual([])
})

it('keeps an existing grant closed during explicit recapture persistence', async () => {
  const f = fixture(true)
  await f.integrity.grantWrite()
  let covered: boolean | undefined
  let request: Promise<void> | undefined
  onRecordWrite(f.record, () => {
    request = setImmediate().then(() => { covered = f.integrity.covers(f.path) })
  })
  await f.integrity.grantWrite()
  await request
  expect(covered).toBe(false)
  expect(f.integrity.covers(f.path)).toBe(true)
})

it('keeps the exact record bytes emitted by the synchronous serializer', async () => {
  const f = fixture()
  await f.integrity.grantWrite()
  const state = f.integrity.exportReviewState()
  const inputs = state.approved.map(([path, value]) => {
    const { files, ...metadata } = value
    return `{"path":${JSON.stringify(path)},"snapshot":${JSON.stringify(metadata).slice(0, -1)}`
      + (files === undefined ? '' : `,"files":[${files.map(file => JSON.stringify(file)).join(',')}]`) + '}}'
  })
  const expected = `{"version":1,"workspace":${JSON.stringify(fs.realpathSync(f.workspace))},"inputs":[${inputs.join(',')}]}\n`
  expect(fs.readFileSync(f.record)).toEqual(Buffer.from(expected))
})
