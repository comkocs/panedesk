/** Local recovery cannot depend on the paired node sending another hello. */
import { expect, test, vi } from 'vitest'
import { localReadyHost } from './local-ready-fixture.ts'

const recovering = { status: 'rejected', error: { code: 'unavailable',
  message: 'Frozen write provider is recovering', retryable: true, effectState: 'none' } }

test('late frozen providers admit two disjoint local seats after recovery without a remote hello', async () => {
  const f = await localReadyHost()
  try {
    vi.useFakeTimers({ toFake: ['Date'] })
    expect(f.ready).toHaveBeenCalled()
    expect(await f.batch()).toMatchObject(recovering)
    expect(await f.local.frozenWrites.run(async () => 'local-write')).toMatchObject(recovering)
    expect(await f.h.engine.frozenWrites.run(async () => 'engine-write')).toMatchObject(recovering)
    expect(f.providerReady.every(ready => ready.mock.calls.length === 0)).toBe(true)
    f.recovery.resolve(undefined)
    await f.local.recover()
    vi.setSystemTime(Date.now() + 86400000)
    const result = await f.batch()
    console.log('offline local recovery result:', JSON.stringify(result))
    expect(result).toMatchObject({ status: 'processed', results: [{ seat: 'seat-a' }, { seat: 'seat-b' }] })
    await expect.poll(() => f.local.frozenWrites.run(async () => 'local-write')).toBe('local-write')
    await expect.poll(() => f.h.engine.frozenWrites.run(async () => 'engine-write')).toBe('engine-write')
    await f.h.engine.drive()
    await f.h.engine.drive()
    const windows = await f.h.ctx.get('seats')!.withAuthority(f.h.authority).list({})
    expect(windows.status).toBe('listed')
    if (windows.status !== 'listed') throw new Error('Expected both local windows')
    expect(windows.sessions.map(window => window.seat).sort()).toEqual(['seat-a', 'seat-b'])
    expect(f.h.adapter.requests).toHaveLength(0)
    expect((await f.h.ctx.get('nodeRouter')!.status())[0]?.reachable).toBe(false)
  } finally { vi.useRealTimers(); await f.close(); vi.restoreAllMocks() }
})

test('failed local recovery keeps both frozen write barriers closed without a remote hello', async () => {
  const f = await localReadyHost()
  try {
    f.recovery.reject(new Error('Controlled local recovery failure'))
    await expect(f.local.recover()).rejects.toThrow('Controlled local recovery failure')
    expect(await f.batch()).toMatchObject(recovering)
    expect(await f.local.frozenWrites.run(async () => 'local-write')).toMatchObject(recovering)
    expect(await f.h.engine.frozenWrites.run(async () => 'engine-write')).toMatchObject(recovering)
  } finally { await f.close(); vi.restoreAllMocks() }
})

test('an inbound hello retries late frozen provider readiness after local recovery', async () => {
  const f = await localReadyHost()
  try {
    expect(await f.batch()).toMatchObject(recovering)
    f.recovery.resolve(undefined)
    await f.local.recover()
    await f.hello()
    await expect.poll(() => f.local.frozenWrites.run(async () => 'local-write')).toBe('local-write')
    await expect.poll(() => f.h.engine.frozenWrites.run(async () => 'engine-write')).toBe('engine-write')
    expect(f.providerReady.every(ready => ready.mock.calls.length > 0)).toBe(true)
    expect(await f.batch()).toMatchObject({ status: 'processed' })
  } finally { await f.close(); vi.restoreAllMocks() }
})
