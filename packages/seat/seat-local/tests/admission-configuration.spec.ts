/** Live permission configuration is checked separately from accounting failures. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

it('parks only the window whose permission preset was removed and clears after repair', async () => {
  const f = await admissionHost(undefined, { failureRecovery: { retryInitialMs: 1000 }, ownerObserveIntervalMs: 60000 })
  try {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('configuration-open'), openingMode: 'prefill' })
    if (opened.status !== 'prefilled') throw new Error('Expected a prefilled window')
    const healthySeat = 'healthy-seat' as T.SeatName
    const entry = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:permissions')
    if (!entry) throw new Error('Expected the permission configuration entry')
    const update = async (repaired: boolean) => {
      await f.ctx.loader.update(entry.id, { config: { defaultPreset: 'permission-b', presets: {
        'permission-b': { sandbox: 'workspace-write', approval: 'ask' },
        ...(repaired ? { 'permission-a': { sandbox: 'workspace-write', approval: 'ask' } } : {}),
      } } })
      await f.ctx.loader.await()
    }
    await update(false)
    expect(await f.seats.resolve(f.definition.seat)).toMatchObject({ status: 'rejected', error: { code: 'invalid-definition', effectState: 'none' } })
    expect(await f.engine.admitTurn(opened.sessionId)).toEqual({ status: 'defer', reason: 'configuring' })
    expect(await f.engine.nodeStatus()).toMatchObject({ engine: 'running', openingFailures: [
      { sessionId: opened.sessionId, seat: f.definition.seat, stage: 'turn', code: 'invalid-definition' },
    ] })
    await f.seats.save({ definition: { ...f.definition, seat: healthySeat, permissionPreset: 'permission-b' },
      expectedRevision: 2, operationId: operation('healthy-configuration') })
    expect(await f.seats.open({ seat: healthySeat, origin: 'manual', operationId: operation('healthy-configuration-open'), openingMode: 'prefill' }))
      .toMatchObject({ status: 'prefilled' })
    expect((await f.engine.nodeStatus()).failure).toBeUndefined()
    await update(true)
    expect(await f.engine.admitTurn(opened.sessionId)).toEqual({ status: 'allow' })
    expect((await f.engine.nodeStatus()).openingFailures).toBeUndefined()
  } finally { await f.close() }
}, 20000)

it.each(['list', 'wake'] as const)('reports an accounting exception from the seat-local %s entry', async (entry) => {
  const f = await admissionHost(undefined, { failureRecovery: { retryInitialMs: 1000 }, ownerObserveIntervalMs: 60000 })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await f.seats.save({ definition: { ...f.definition, wakeTemplate: { kind: 'text', text: 'Continue.' } },
      expectedRevision: 2, operationId: operation('site-definition') })
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('site-open'), openingMode: 'prefill' })
    if (opened.status !== 'prefilled') throw new Error('Expected a prefilled window')
    const error = Object.assign(new Error('Untrusted accounting detail'), { code: 'state-conflict' })
    vi.spyOn(f.engine, 'budget').mockRejectedValue(error)
    const query = entry === 'list' ? f.seats.list({}) : f.seats.wake({ seat: f.definition.seat,
      sessionId: opened.sessionId, operationId: operation('site-wake') })
    await expect(query).rejects.toBe(error)
    expect((await f.engine.nodeStatus()).failure).toMatchObject({ site: `seat-local/${entry}`, code: 'state-conflict', retryable: false })
  } finally { vi.restoreAllMocks(); await f.close() }
}, 15000)
