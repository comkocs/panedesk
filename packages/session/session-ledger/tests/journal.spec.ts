import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { appendUnique, recoverSegments, appendArtifact, finishArtifact, resolveNodeId } from '../src/journal.ts'
import { LedgerUnavailableError, withWriterLock } from '../src/lock.ts'
import { rebuildIndex } from '../src/index-store.ts'
import { event, options, callStart } from './fixtures.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }))

const roots: string[] = []
async function root() {
  const path = await fs.mkdtemp(join(import.meta.dirname, '.journal-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})

async function segments(path: string): Promise<string[]> {
  return (await fs.readdir(path, { recursive: true })).filter(name => name.endsWith('.jsonl')).map(name => join(path, name))
}

describe('journal', () => {
  it('replays equal facts and preserves unequal event or terminal slots', async () => {
    const path = await root()
    expect((await appendUnique(path, event(), options)).kind).toBe('appended')
    expect((await appendUnique(path, event(), options)).kind).toBe('existing')
    const conflict = event()
    conflict.observedAt++
    expect((await appendUnique(path, conflict, options)).kind).toBe('conflict')
    await appendUnique(path, event('call/end'), options)
    const end = event('call/end')
    end.eventId = 'another-end' as typeof end.eventId
    if (end.kind === 'call/end') end.data.endReason = 'killed'
    expect((await appendUnique(path, end, options)).kind).toBe('conflict')
    expect((await recoverSegments(path, options.maxRecordBytes)).events).toHaveLength(2)
  })

  it('handles short writes by completing every byte before acknowledgement', async () => {
    const path = await root()
    const open = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[1] === 'wx') {
        const write = handle.write.bind(handle)
        vi.spyOn(handle, 'write').mockImplementation((...writeArgs: Parameters<typeof handle.write>) => {
          const [buffer, offset, length] = writeArgs
          if (Buffer.isBuffer(buffer) && typeof offset === 'number' && typeof length === 'number') return write(buffer, offset, Math.min(length, 7))
          return write(...writeArgs)
        })
      }
      return handle
    })
    await appendUnique(path, event(), options)
    expect((await recoverSegments(path, options.maxRecordBytes)).events).toEqual([event()])
  })

  it('retains partial tails after disk-full and writes a new segment on retry', async () => {
    const path = await root()
    const open = fs.open
    let injected = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[1] === 'wx' && !injected) {
        injected = true
        const write = handle.write.bind(handle)
        let first = true
        vi.spyOn(handle, 'write').mockImplementation(async (...writeArgs: Parameters<typeof handle.write>) => {
          if (!first) throw Object.assign(new Error('Storage full'), { code: 'ENOSPC' })
          first = false
          const buffer = writeArgs[0]
          if (!Buffer.isBuffer(buffer)) throw new Error('Expected bytes')
          return write(buffer, 0, 10)
        })
      }
      return handle
    })
    await expect(appendUnique(path, event(), options)).rejects.toMatchObject({ code: 'ENOSPC' })
    vi.restoreAllMocks()
    const partial = (await segments(path))[0]!
    const before = await fs.readFile(partial)
    await appendUnique(path, event(), options)
    expect(await fs.readFile(partial)).toEqual(before)
    const scan = await recoverSegments(path, options.maxRecordBytes)
    expect(scan.events.filter(item => item.kind === 'call/start')).toHaveLength(1)
    expect(scan.events.filter(item => item.kind === 'alert')).toHaveLength(1)
    expect(scan.tails).toEqual([partial])
    expect(scan.complete).toBe(false)
  })

  it('resynchronizes a complete record after a lost fsync acknowledgement', async () => {
    const path = await root()
    const open = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[1] === 'wx') {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { await sync(); throw new Error('Acknowledgement lost') })
      }
      return handle
    })
    await expect(appendUnique(path, event(), options)).rejects.toThrow('Acknowledgement lost')
    vi.restoreAllMocks()
    expect((await appendUnique(path, event(), options)).kind).toBe('existing')
    expect((await segments(path))).toHaveLength(1)
  })

  it('rejects complete-line corruption and rebuilds a lost index across UTC dates', async () => {
    const path = await root()
    await appendUnique(path, event(), options)
    const file = (await segments(path))[0]!
    const old = join(path, 'events', '2000-01-01')
    await fs.mkdir(old)
    await fs.rename(file, join(old, 'old.jsonl'))
    await appendUnique(path, event('call/end'), options)
    const scan = await recoverSegments(path, options.maxRecordBytes)
    expect(rebuildIndex(scan.events).slots.size).toBe(2)
    await fs.appendFile(join(old, 'old.jsonl'), '{}\n')
    expect((await recoverSegments(path, options.maxRecordBytes)).complete).toBe(false)
    await expect(appendUnique(path, event('run/start'), options)).rejects.toThrow('corruption')
  })

  it('rejects invalid persisted request-header sequence associations', async () => {
    const path = await root()
    for (const sequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = event()
      if (invalid.kind !== 'call/start') throw new Error('Expected call start')
      invalid.data.requestHeaderSeq = sequence
      await expect(appendUnique(path, invalid, options)).rejects.toThrow('Invalid request header sequence')
    }
  })

  it('uses stable owner-only lock files and bounds contention without replacing their inode', async () => {
    const path = await root()
    const lock = join(path, 'writer.lock')
    await withWriterLock(lock, options, async () => {
      const before = await fs.stat(lock)
      await expect(withWriterLock(lock, { lockTimeoutMs: 15, lockRetryMs: 2 }, async () => 1)).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' })
      expect((await fs.stat(lock)).ino).toBe(before.ino)
    })
    await appendUnique(path, event(), options)
    expect((await fs.stat(lock)).mode & 0o777).toBe(0o600)
    expect((await fs.stat((await segments(path))[0]!)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(join(path, 'events'))).mode & 0o777).toBe(0o700)
  })

  it('reports the verified lock holder and elapsed ownership without stealing the lock', async () => {
    const path = await root()
    const lock = join(path, 'writer.lock')
    await withWriterLock(lock, options, async () => {
      const failure = await withWriterLock(lock, { lockTimeoutMs: 25, lockRetryMs: 2 }, async () => 1)
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'LEDGER_UNAVAILABLE', lockTimeoutCode: 'LEDGER_LOCK_TIMEOUT' })
      if (!(failure instanceof LedgerUnavailableError)) throw new Error('Expected ledger lock timeout')
      if (process.platform === 'linux') {
        expect(failure.lockHolder?.pid).toBe(process.pid)
        expect(typeof failure.lockHolder?.heldMs).toBe('number')
        expect(failure.lockHolder!.heldMs).toBeGreaterThanOrEqual(0)
        expect(failure.lockHolder!.acquiredAt).toBeLessThanOrEqual(Date.now())
        expect(new LedgerUnavailableError(failure).lockHolder).toEqual(failure.lockHolder)
      }
    })
  })

  it.skipIf(process.platform !== 'linux')('omits unreadable and reused-process holder identities and clears released metadata', async () => {
    const path = await root()
    const lock = join(path, 'writer.lock')
    await withWriterLock(lock, options, async () => {
      const stale: unknown = JSON.parse(await fs.readFile(lock, 'utf8'))
      if (!stale || typeof stale !== 'object') throw new Error('Expected holder metadata')
      await fs.writeFile(lock, JSON.stringify({ ...stale, startIdentity: 'reused-process' }))
      const failure = await withWriterLock(lock, { lockTimeoutMs: 10, lockRetryMs: 2 }, async () => 1).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'LEDGER_UNAVAILABLE', lockTimeoutCode: 'LEDGER_LOCK_TIMEOUT' })
      expect(failure).not.toHaveProperty('lockHolder', expect.objectContaining({ pid: process.pid }))
      await fs.writeFile(lock, 'unreadable metadata')
      const unreadable = await withWriterLock(lock, { lockTimeoutMs: 10, lockRetryMs: 2 }, async () => 1).catch((error: unknown) => error)
      expect(unreadable).toMatchObject({ code: 'LEDGER_UNAVAILABLE' })
      expect(unreadable).not.toHaveProperty('lockHolder', expect.objectContaining({ pid: process.pid }))
    })
    expect((await fs.readFile(lock, 'utf8')).trim()).toBe('')
  })

  it('serializes simultaneous child-process writers into one unique slot', async () => {
    const path = await root()
    const fixture = join(import.meta.dirname, 'journal-child.ts')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
    env.TSX_TSCONFIG_PATH = join(import.meta.dirname, '../../../../tsconfig.json')
    const args = ['--import', 'tsx/esm', fixture, path, JSON.stringify(event())]
    const children = Array.from({ length: 4 }, () => spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
    const results = children.map(child => new Promise<string>((resolve, reject) => {
      let output = ''
      let errors = ''
      child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString() })
      child.once('error', reject)
      child.once('close', (code) => { if (code === 0) resolve(output.trim()); else reject(new Error(errors)) })
    }))
    const completed = Promise.all(results)
    void completed.catch(() => { /* The readiness race below owns the failure. */ })
    try {
      const ready = Promise.all(children.map(child => new Promise<void>((resolve) => { child.once('message', () => { resolve() }) })))
      await Promise.race([ready, completed])
      for (const child of children) child.send('go')
      const values = await Promise.all(results)
      expect(values.filter(value => value === 'appended')).toHaveLength(1)
      expect(values.filter(value => value === 'existing')).toHaveLength(3)
      expect((await recoverSegments(path, options.maxRecordBytes)).events).toHaveLength(1)
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await Promise.allSettled(results)
    }
  })

  it('persists a random node identity across independent initializations', async () => {
    const path = await root()
    const ids = await Promise.all([resolveNodeId(path, options), resolveNodeId(path, options)])
    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/)
  })
})

describe('artifact journal', () => {
  it('replays fragments and closures after lost fsync acknowledgements without duplicating bytes', async () => {
    const path = await root()
    const input = { callId: callStart.callId, kind: 'partial-response' as const, seq: 0, content: '"part"' }
    const inject = () => {
      const open = fs.open
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (args[1] === 'wx') {
          const sync = handle.sync.bind(handle)
          vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { await sync(); throw new Error('Acknowledgement lost') })
        }
        return handle
      })
    }
    inject()
    await expect(appendArtifact(path, input, options)).rejects.toThrow('Acknowledgement lost')
    vi.restoreAllMocks()
    const replay = await appendArtifact(path, input, options)
    expect(replay.kind).toBe('existing')
    if (replay.kind === 'conflict') throw new Error('Unexpected conflict')
    inject()
    await expect(finishArtifact(path, replay.reference, options)).rejects.toThrow('Acknowledgement lost')
    vi.restoreAllMocks()
    expect((await finishArtifact(path, replay.reference, options)).kind).toBe('existing')
    expect((await segments(path))).toHaveLength(2)
  })
  it('preserves exact JSON bytes, rejects gaps, and seals only the final fragment', async () => {
    const path = await root()
    const input = { callId: callStart.callId, kind: 'partial-response' as const, seq: 0, content: '{ "text": "part" }' }
    await expect(appendArtifact(path, { ...input, seq: 1 }, options)).rejects.toThrow('contiguous')
    await expect(appendArtifact(path, { ...input, content: '{' }, options)).rejects.toThrow()
    const first = await appendArtifact(path, input, options)
    if (first.kind === 'conflict') throw new Error('Unexpected conflict')
    expect((await appendArtifact(path, input, options)).kind).toBe('existing')
    expect((await appendArtifact(path, { ...input, content: '{"text":"part"}' }, options)).kind).toBe('conflict')
    const second = await appendArtifact(path, { ...input, seq: 1, content: 'null' }, options)
    if (second.kind === 'conflict') throw new Error('Unexpected conflict')
    await expect(finishArtifact(path, first.reference, options)).rejects.toThrow('final')
    expect((await finishArtifact(path, second.reference, options)).kind).toBe('finished')
    expect((await finishArtifact(path, second.reference, options)).kind).toBe('existing')
    expect((await appendArtifact(path, input, options)).kind).toBe('existing')
    await expect(appendArtifact(path, { ...input, seq: 2 }, options)).rejects.toThrow('closed')
    expect(await fs.stat(join(path, first.reference.path))).toBeDefined()
  })

  it('keeps independent artifact kinds separate and rejects forged closure references', async () => {
    const path = await root()
    const input = { callId: callStart.callId, kind: 'keepalive-request' as const, seq: 0, content: '{"messages":[]}' }
    const result = await appendArtifact(path, input, options)
    if (result.kind === 'conflict') throw new Error('Unexpected conflict')
    await expect(finishArtifact(path, { ...result.reference, path: '../other' }, options)).rejects.toThrow('final')
    expect((await appendArtifact(path, { ...input, kind: 'partial-response' }, options)).kind).toBe('appended')
  })
})
