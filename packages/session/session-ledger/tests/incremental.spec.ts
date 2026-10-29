import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { Context } from '@panedesk/cordis'
import { JournalSessionLedger } from '../src/index.ts'
import { appendUnique, appendArtifact, finishArtifact, readJournal, recoverSegments, JournalViewOwner, readJournalFacts } from '../src/journal.ts'
import { event, options as journalOptions, callStart, callFinish } from './fixtures.ts'
import { foldLedger } from '../src/projection.ts'
import { callWaits } from '../src/call-waits.ts'
import { digest } from '../src/index-store.ts'
import { randomUUID } from 'node:crypto'
import * as crypto from 'node:crypto'
import type { LedgerEvent, LedgerEventId } from '../src/types.ts'

vi.mock('node:crypto', async original => ({ ...await original<typeof crypto>() }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof fs>() }))
const roots: string[] = []
const contexts: Context[] = []
let options = { ...journalOptions, viewOwner: new JournalViewOwner() }
afterEach(async () => {
  vi.restoreAllMocks()
  options.viewOwner.dispose()
  options = { ...journalOptions, viewOwner: new JournalViewOwner() }
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})
async function root() {
  const path = await fs.mkdtemp(join(import.meta.dirname, '.incremental-'))
  roots.push(path)
  return path
}
function fact(id: string) {
  const value = event()
  if (value.kind !== 'call/start') throw new Error('Expected call start')
  return { ...value, eventId: id as LedgerEventId, callId: id as typeof value.data.callId,
    data: { ...value.data, callId: id as typeof value.data.callId } }
}
function child(root: string, mode: string, writer: string) {
  const env = Object.fromEntries(Object.entries(globalThis.process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  env.TSX_TSCONFIG_PATH = join(import.meta.dirname, '../../../../tsconfig.json')
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx/esm', join(import.meta.dirname, 'append-child.ts'), root, mode, writer],
    { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''
  process.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString() })
  const exit = new Promise<number | null>((resolve, reject) => { process.once('error', reject); process.once('exit', resolve) })
  const confirmed: string[] = []
  const checkpoint = new Promise<void>((resolve, reject) => {
    process.on('message', (value) => {
      if (value === null || typeof value !== 'object') return
      if ('ready' in value) process.send('go')
      if ('confirmed' in value && typeof value.confirmed === 'string' && 'kind' in value && value.kind === 'appended') confirmed.push(value.confirmed)
      if ('phase' in value) resolve()
    })
    void exit.then(() =>{  reject(new Error(`Child exited before checkpoint: ${errors}`)) }, reject)
  })
  void checkpoint.catch(() => { /* Concurrent mode owns only the exit result. */ })
  return { process, exit, checkpoint, confirmed }
}

it.each(['partial-write', 'before-file-sync', 'before-directory-sync'])('retains acknowledged facts after four kills at %s', async (phase) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const path = await root()
    await appendUnique(path, fact('old'), options)
    const writer = child(path, phase, `writer-${attempt}`)
    try {
      await writer.checkpoint
      expect(writer.process.pid).toBeTypeOf('number')
      writer.process.kill('SIGKILL')
      await writer.exit
      const scan = await recoverSegments(path, options.maxRecordBytes)
      const ids = scan.events.map(item => item.eventId)
      expect(ids).toContain('old')
      for (const id of writer.confirmed) expect(ids).toContain(id)
      expect(scan.corrupt).toEqual([])
      expect(scan.tails).toHaveLength(phase === 'partial-write' ? 1 : 0)
      await appendUnique(path, fact('after-restart'), options)
      expect((await recoverSegments(path, options.maxRecordBytes)).events.map(item => item.eventId)).toContain('after-restart')
    } finally {
      if (writer.process.exitCode === null && writer.process.signalCode === null) writer.process.kill('SIGKILL')
      await writer.exit
    }
  }
}, 30000)

it('abandons a segment after file sync failure and retries the key exactly once', async () => {
  const path = await root()
  await appendUnique(path, fact('old'), options)
  const original = fs.open
  let injected = false
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (args[1] === 'a' && !injected) {
      injected = true
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Injected file sync failure'))
    }
    return handle
  })
  await expect(appendUnique(path, fact('retry'), options)).rejects.toThrow('Injected file sync failure')
  vi.restoreAllMocks()
  expect((await appendUnique(path, fact('retry'), options)).kind).toBe('existing')
  await appendUnique(path, fact('next'), options)
  expect((await fs.readdir(join(path, 'events'), { recursive: true })).filter(name => name.endsWith('.jsonl'))).toHaveLength(2)
  expect((await recoverSegments(path, options.maxRecordBytes)).events.map(item => item.eventId).sort()).toEqual(['next', 'old', 'retry'])
})

it('serializes two processes without losing facts or duplicating slots', async () => {
  const path = await root()
  const writers = [child(path, 'concurrent', 'left'), child(path, 'concurrent', 'right')]
  try {
    expect(await Promise.all(writers.map(writer => writer.exit))).toEqual([0, 0])
    const scan = await readJournal(path, options)
    expect(scan.complete).toBe(true)
    expect(scan.events).toHaveLength(24)
    expect(new Set(scan.events.map(value => value.callId)).size).toBe(24)
  } finally {
    for (const writer of writers) if (writer.process.exitCode === null && writer.process.signalCode === null) writer.process.kill('SIGKILL')
    await Promise.all(writers.map(writer => writer.exit))
  }
})

it('keeps write read and sync counts equal at fifty and one thousand existing facts', async () => {
  const path = await root()
  const counts: { reads: number; syncs: number }[] = []
  for (let i = 0; i <= 1000; i++) {
    if (i === 50 || i === 1000) {
      const count = { reads: 0, syncs: 0 }
      const original = fs.open
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await original(...args)
        const read = handle.read.bind(handle)
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'read').mockImplementation((...values: Parameters<typeof handle.read>) => { count.reads++; return read(...values) })
        vi.spyOn(handle, 'sync').mockImplementation(async () => { count.syncs++; await sync() })
        return handle
      })
      const readFile = vi.spyOn(fs, 'readFile')
      await appendUnique(path, fact(String(i)), options)
      count.reads += readFile.mock.calls.length
      counts.push(count)
      vi.restoreAllMocks()
    } else await appendUnique(path, fact(String(i)), options)
  }
  expect(counts[0]).toEqual(counts[1])
  expect(counts[0]).toEqual({ reads: 0, syncs: 2 })
  expect(await readJournal(path, options)).toEqual(await recoverSegments(path, options.maxRecordBytes))
}, 30000)

it('segments non-call facts without changing event identities or process UUID consumption', async () => {
  const path = await root()
  const uuid = vi.spyOn(crypto, 'randomUUID')
  const facts: LedgerEvent[] = []
  const counts: number[] = []
  for (let i = 0; i <= 1000; i++) {
    const value: LedgerEvent = {
      schemaVersion: 1, eventId: `evidence-${i}` as LedgerEventId, nodeId: callStart.nodeId,
      sessionId: callStart.sessionId, runId: callStart.runId, observedAt: i,
      kind: 'cache/evidence', evidence: { cacheMode: 'unknown', breakReasons: [] },
    }
    facts.push(value)
    const stats = vi.spyOn(fs, 'stat')
    expect((await appendUnique(path, value, options)).kind).toBe('appended')
    if (i === 50 || i === 1000) counts.push(stats.mock.calls.length)
    stats.mockRestore()
  }
  expect(uuid).toHaveBeenCalledTimes(facts.length)
  expect((await appendUnique(path, facts[0]!, options)).kind).toBe('existing')
  expect(uuid).toHaveBeenCalledTimes(facts.length)
  await appendUnique(path, fact('call'), options)
  expect(uuid).toHaveBeenCalledTimes(facts.length)
  expect(counts[0]).toBe(counts[1])
  const directory = join(path, 'events', new Date().toISOString().slice(0, 10))
  const files = await fs.readdir(directory)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^segment-/)
  const scan = await recoverSegments(path, options.maxRecordBytes)
  expect(scan.events).toEqual([...facts, fact('call')])
  expect(await readJournal(path, options)).toEqual(scan)
}, 30000)

it.each([50, 1000])('matches every settlement field using keyed waits with %i facts', async (count) => {
  const path = await root()
  for (let i = 0; i < count; i++) await appendUnique(path, fact(`unrelated-${i}`), options)
  const toolCallId = 'tool-a' as NonNullable<typeof callFinish.toolCallIds>[number]
  for (const kind of ['wait/start', 'wait/end'] as const) await appendUnique(path, {
    schemaVersion: 1, eventId: kind as LedgerEventId, nodeId: callStart.nodeId,
    sessionId: callStart.sessionId, runId: callStart.runId, observedAt: kind === 'wait/start' ? 120 : 150,
    kind, interval: { kind: 'sleep', toolCallId, startedAt: 120, ...kind === 'wait/end' ? { endedAt: 150, durationMs: 30 } : {} },
  }, options)
  const full = await readJournal(path, options)
  const selected = await readJournalFacts(path, options, { kind: 'waits', nodeId: callStart.nodeId,
    sessionId: callStart.sessionId, runId: callStart.runId, toolCallIds: [toolCallId] })
  expect(selected.events).toHaveLength(2)
  const project = (events: typeof full.events) => foldLedger(events, { asOf: 300, observationMaxAgeMs: 10000 })
  const oldFinish = { ...callFinish, waits: callWaits(project(full.events), callStart, [toolCallId]) }
  const newFinish = { ...callFinish, waits: callWaits(project(selected.events), callStart, [toolCallId]) }
  expect(newFinish).toEqual(oldFinish)
  expect(newFinish.waits).toEqual([{ kind: 'sleep', toolCallId, startedAt: 120, endedAt: 150, durationMs: 30 }])
}, 30000)

it('reclaims a shared view only after its last Context releases it', async () => {
  const home = await root()
  const first = new Context(); const second = new Context(); const third = new Context()
  contexts.push(first, second, third)
  const a = new JournalSessionLedger(first, { dshHome: home })
  const b = new JournalSessionLedger(second, { dshHome: home })
  await a.beginCall(callStart)
  await b.snapshot()
  await first.fiber.dispose()
  const original = fs.open
  let reads = 0
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    const read = handle.read.bind(handle)
    vi.spyOn(handle, 'read').mockImplementation((...values: Parameters<typeof handle.read>) => { reads++; return read(...values) })
    return handle
  })
  await b.snapshot()
  expect(reads).toBe(0)
  await second.fiber.dispose()
  const c = new JournalSessionLedger(third, { dshHome: home })
  await c.snapshot()
  expect(reads).toBeGreaterThan(0)
})

it('isolates record limits and shares canonical paths through a home alias', async () => {
  const home = await root()
  const container = await root()
  const alias = join(container, 'alias')
  await fs.symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const first = new Context(); const second = new Context(); const limited = new Context()
  contexts.push(first, second, limited)
  const a = new JournalSessionLedger(first, { dshHome: home })
  const b = new JournalSessionLedger(second, { dshHome: alias })
  const c = new JournalSessionLedger(limited, { dshHome: home, maxRecordBytes: 128 })
  await a.beginCall(callStart)
  await b.nodeId()
  const original = fs.open
  let reads = 0
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    const read = handle.read.bind(handle)
    vi.spyOn(handle, 'read').mockImplementation((...values: Parameters<typeof handle.read>) => { reads++; return read(...values) })
    return handle
  })
  expect((await b.snapshot()).complete).toBe(true)
  expect(reads).toBe(0)
  expect((await c.snapshot()).complete).toBe(false)
  expect(reads).toBeGreaterThan(0)
  expect((await a.snapshot()).complete).toBe(true)
})

it('does not stat previously synchronized legacy UUID facts', async () => {
  const path = await root()
  await appendUnique(path, fact('old'), options)
  const directory = join(path, 'events', new Date().toISOString().slice(0, 10))
  const file = (await fs.readdir(directory))[0]!
  const legacy = join(directory, `${randomUUID()}.jsonl`)
  await fs.rename(join(directory, file), legacy)
  await readJournal(path, options)
  const stats = vi.spyOn(fs, 'stat')
  await appendUnique(path, fact('new'), options)
  expect(stats.mock.calls.some(([path]) => path === legacy)).toBe(false)
  expect((await readJournal(path, options)).events).toHaveLength(2)
})

it('reuses closure contents for all hot readers without reading file bytes again', async () => {
  const home = await root()
  const ctx = new Context()
  contexts.push(ctx)
  const ledger = new JournalSessionLedger(ctx, { dshHome: home })
  await ledger.beginCall(callStart)
  const fragment = await ledger.appendArtifact({ callId: callStart.callId, kind: 'partial-response', seq: 0, content: '0' })
  if (fragment.kind === 'conflict') throw new Error('Unexpected conflict')
  await ledger.finishArtifact(fragment.reference)
  const node = join(home, 'ledger/v1', await ledger.nodeId())
  const selections = ['open-runs', 'waits', 'latest-start'].map(kind => ({
    kind: kind as 'open-runs' | 'waits' | 'latest-start', sessionId: callStart.sessionId,
    nodeId: callStart.nodeId, runId: callStart.runId, toolCallIds: [],
  }))
  for (const selection of selections) await readJournalFacts(node, options, selection)
  const original = fs.open
  let reads = 0
  let bytes = 0
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    const read = handle.read.bind(handle)
    vi.spyOn(handle, 'read').mockImplementation(async (...values: Parameters<typeof handle.read>) => {
      reads++
      const result = await read(...values)
      bytes += result.bytesRead
      return result
    })
    return handle
  })
  const readFile = vi.spyOn(fs, 'readFile')
  const directories = vi.spyOn(fs, 'readdir')
  const stats = vi.spyOn(fs, 'stat')
  for (const selection of selections) {
    await readJournalFacts(node, options, selection)
    expect({ reads, bytes, readFiles: readFile.mock.calls.length }).toEqual({ reads: 0, bytes: 0, readFiles: 0 })
  }
  expect(directories.mock.calls.some(([path]) => String(path).includes('artifacts'))).toBe(true)
  expect(stats.mock.calls.some(([path]) => String(path).includes('closed-'))).toBe(true)
})

it('keeps hot-reader filesystem counts constant with fifty and three thousand unrelated streams', async () => {
  const path = await root()
  await appendUnique(path, event(), options)
  await appendUnique(path, event('run/start'), options)
  const toolCallId = 'tool-a' as NonNullable<typeof callFinish.toolCallIds>[number]
  await appendUnique(path, { ...event(), kind: 'wait/start', eventId: 'wait-a' as LedgerEventId,
    interval: { kind: 'sleep', startedAt: 100, toolCallId } }, options)
  const first = await appendArtifact(path, { callId: callStart.callId, kind: 'partial-response', seq: 0, content: '0' }, options)
  if (first.kind === 'conflict') throw new Error('Unexpected conflict')
  await finishArtifact(path, first.reference, options)
  const selections = ['open-runs', 'waits', 'latest-start'].map(kind => ({
    kind: kind as 'open-runs' | 'waits' | 'latest-start', sessionId: callStart.sessionId,
    nodeId: callStart.nodeId, runId: callStart.runId, toolCallIds: [toolCallId],
  }))
  for (const selection of selections) await readJournalFacts(path, options, selection)
  const counts: {
    size: number
    kind: string
    directories: number
    stats: number
    lstats: number
    reads: number
    bytes: number
    readFiles: number
  }[] = []
  for (let i = 1; i <= 3000; i++) {
    // Unrelated durable streams need no journal facts: only artifact history varies between samples.
    const fragment = await appendArtifact(path, { callId: `unrelated-${i}` as typeof callStart.callId,
      kind: 'partial-response', seq: 0, content: '0' }, options)
    if (fragment.kind === 'conflict') throw new Error('Unexpected conflict')
    await finishArtifact(path, fragment.reference, options)
    if (i !== 50 && i !== 3000) continue
    for (const selection of selections) {
      const count = { size: i, kind: selection.kind, directories: 0, stats: 0, lstats: 0, reads: 0, bytes: 0, readFiles: 0 }
      const original = fs.open
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await original(...args)
        const read = handle.read.bind(handle)
        vi.spyOn(handle, 'read').mockImplementation(async (...values: Parameters<typeof handle.read>) => {
          count.reads++
          const result = await read(...values)
          count.bytes += result.bytesRead
          return result
        })
        return handle
      })
      const directories = vi.spyOn(fs, 'readdir')
      const stats = vi.spyOn(fs, 'stat')
      const lstats = vi.spyOn(fs, 'lstat')
      const readFiles = vi.spyOn(fs, 'readFile')
      await readJournalFacts(path, options, selection)
      count.directories = directories.mock.calls.length
      count.stats = stats.mock.calls.length
      count.lstats = lstats.mock.calls.length
      count.readFiles = readFiles.mock.calls.length
      expect(directories.mock.calls.some(([entry]) => entry === join(path, 'artifacts'))).toBe(false)
      expect(directories.mock.calls.filter(([entry]) => String(entry).includes('artifacts')).every(([entry]) =>
        String(entry).startsWith(join(path, 'artifacts', digest(callStart.callId))))).toBe(true)
      expect({ reads: count.reads, bytes: count.bytes, readFiles: count.readFiles }).toEqual({ reads: 0, bytes: 0, readFiles: 0 })
      counts.push(count)
      vi.restoreAllMocks()
    }
  }
  console.log(JSON.stringify(counts))
  expect(counts.filter(row => row.size === 3000).map(({ size: _size, ...row }) => row))
    .toEqual(counts.filter(row => row.size === 50).map(({ size: _size, ...row }) => row))
}, 120000)

it('shares synchronized bytes across independent Context instances', async () => {
  const home = await root()
  const first = new Context(); const second = new Context()
  contexts.push(first, second)
  const a = new JournalSessionLedger(first, { dshHome: home })
  const b = new JournalSessionLedger(second, { dshHome: home })
  await a.beginCall(callStart)
  await b.nodeId()
  const reads = vi.spyOn(fs, 'readFile')
  await b.finishCall(callFinish)
  expect(reads).not.toHaveBeenCalled()
  expect((await a.snapshot()).rows).toEqual((await b.snapshot()).rows)
})
