/** Only local recorded model facts may become callback execution evidence. */
import { expect, test, vi } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { readExecutionModel } from '../src/model-evidence.ts'

test('reads the created execution Session selection and reports absent records without configured fallback', async () => {
  const f = await admissionHost()
  try {
    expect(await readExecutionModel(f.ctx, null, f.options.nodeId)).toMatchObject({ status: 'missing', sessionId: null })
    const result = await f.seats.open({ seat: f.definition.seat, operationId: operation('evidence'),
      origin: 'manual', openingMode: 'prefill' })
    if (result.status !== 'prefilled') throw new Error('Expected prefilled Session')
    const evidence = await readExecutionModel(f.ctx, result.sessionId, f.options.nodeId)
    expect(evidence).toMatchObject({ status: 'present', kind: 'model/selection', sessionId: result.sessionId,
      nodeId: f.options.nodeId, provider: f.definition.provider, model: f.definition.model })
    expect(f.adapter.requests).toHaveLength(0)
    expect(await readExecutionModel(f.ctx, 'absent-session' as SessionId, f.options.nodeId)).toMatchObject({ status: 'missing' })
    const query = f.ctx.get('sessionQuery')!
    const spy = vi.spyOn(query, 'readSession').mockRejectedValueOnce(new Error('Unreadable execution log'))
    try { expect(await readExecutionModel(f.ctx, result.sessionId, f.options.nodeId)).toMatchObject({ status: 'missing' }) }
    finally { spy.mockRestore() }
  } finally { await f.close() }
})

test('reads request headers after a real execution without issuing another model request', async () => {
  const f = await admissionHost()
  try {
    const result = await f.seats.open({ seat: f.definition.seat, operationId: operation('header-evidence'),
      origin: 'manual', openingMode: 'auto' })
    if (result.status !== 'opened') throw new Error('Expected opened Session')
    await vi.waitFor(async () => {
      await f.ctx.get('sessionPersistence')!.flush()
      expect(await readExecutionModel(f.ctx, result.sessionId, f.options.nodeId)).toMatchObject({ status: 'present',
        kind: 'request/header', provider: f.definition.provider, model: f.definition.model, sessionId: result.sessionId })
    }, { timeout: 10000 })
    expect(f.adapter.requests).toHaveLength(1)
  } finally { await f.close() }
}, 15000)
