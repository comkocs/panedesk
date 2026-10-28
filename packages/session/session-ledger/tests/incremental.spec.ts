import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { Context } from '@panedesk/cordis'
import { JournalSessionLedger } from '../src/index.ts'
import { appendUnique, readJournal, recoverSegments } from '../src/journal.ts'
import { event, options, callStart, callFinish } from './fixtures.ts'
import type { LedgerEventId } from '../src/types.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof fs>() }))
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
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
