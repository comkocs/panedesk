/** Holder diagnostics publish only for slow ownership and never outlive their descriptor. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as syncFs from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerUnavailableError, withWriterLock } from '../src/lock.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof syncFs>() }))

const roots: string[] = []
const options = { lockTimeoutMs: 5000, lockRetryMs: 10 }
async function lockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ledger-holder-'))
  roots.push(root)
  return join(root, 'writer.lock')
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('slow writer holder publication', () => {
  it('does not write metadata for fast ownership or after early release', async () => {
    const path = await lockPath()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const writes = vi.spyOn(syncFs, 'writeSync')
    await withWriterLock(path, options, async () => {
      expect(writes).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(writes).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes slow ownership with the original acquisition time and an unreferenced timer', async () => {
    const path = await lockPath()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const writes = vi.spyOn(syncFs, 'writeSync')
    await withWriterLock(path, options, async () => {
      const acquiredAt = Date.now()
      expect(writes).not.toHaveBeenCalled()
      const timer = timers.mock.results[0]
      if (timer?.type !== 'return') throw new Error('Expected holder timer')
      expect(timer.value.hasRef()).toBe(false)
      await vi.advanceTimersByTimeAsync(4)
      expect(writes).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(writes).toHaveBeenCalledTimes(1)
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      expect(value).toMatchObject({ pid: process.pid, acquiredAt })
    })
  })

  it.skipIf(process.platform !== 'linux')('reports the slow holder and duration to a timed-out waiter', async () => {
    const path = await lockPath()
    await withWriterLock(path, options, async () => {
      const started = Date.now()
      const failure = await withWriterLock(path, { lockTimeoutMs: 25, lockRetryMs: 2 }, async () => 1)
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(LedgerUnavailableError)
      if (!(failure instanceof LedgerUnavailableError)) throw new Error('Expected lock timeout')
      expect(failure.lockHolder).toMatchObject({ pid: process.pid })
      expect(failure.lockHolder!.acquiredAt).toBeLessThanOrEqual(started)
      expect(failure.lockHolder!.heldMs).toBeGreaterThanOrEqual(25)
      expect(failure.message).toContain(`held for ${failure.lockHolder!.heldMs} ms`)
    })
  })

  it('clears published metadata before releasing ownership on operation failure', async () => {
    const path = await lockPath()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const writes = vi.spyOn(syncFs, 'writeSync')
    const failure = new Error('Operation failed')
    await expect(withWriterLock(path, options, async () => {
      expect(writes).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5)
      expect((await readFile(path, 'utf8')).trim()).not.toBe('')
      throw failure
    })).rejects.toBe(failure)
    expect(writes).toHaveBeenCalledTimes(2)
    expect((await readFile(path, 'utf8')).trim()).toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no metadata when the operation settles during publication', async () => {
    const path = await lockPath()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const write = syncFs.writeSync
    let settle: (() => void) | undefined
    const completed = new Promise<void>((resolve) => { settle = resolve })
    const writes = vi.spyOn(syncFs, 'writeSync').mockImplementation((...args: Parameters<typeof syncFs.writeSync>) => {
      settle?.()
      return write(...args)
    })
    let entered: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const held = withWriterLock(path, options, async () => {
      entered?.()
      expect(writes).not.toHaveBeenCalled()
      await completed
    })
    await ready
    await vi.advanceTimersByTimeAsync(5)
    await held
    expect(writes).toHaveBeenCalledTimes(2)
    expect((await readFile(path, 'utf8')).trim()).toBe('')
    await vi.advanceTimersByTimeAsync(100)
    expect(writes).toHaveBeenCalledTimes(2)
  })
})
