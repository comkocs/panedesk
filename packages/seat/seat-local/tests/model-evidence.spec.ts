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

test('waits for the same request header to enter the ledger during a 250 ms acknowledgement delay', async () => {
  const f = await admissionHost()
  const ledger = f.ctx.get('sessionLedger')!
  const begin = ledger.beginCall.bind(ledger)
  const entered = Promise.withResolvers<undefined>()
  let committed = false
  const slow = vi.spyOn(ledger, 'beginCall').mockImplementation(async (input) => {
    entered.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 250))
    const result = await begin(input)
    committed = true
    return result
  })
  try {
    const result = await f.seats.open({ seat: f.definition.seat, operationId: operation('slow-header-evidence'),
      origin: 'manual', openingMode: 'auto' })
    if (result.status !== 'opened') throw new Error('Expected opened Session')
    await entered.promise
    await f.ctx.get('sessionPersistence')!.flush()
    expect(f.adapter.requests).toHaveLength(0)
    expect(await readExecutionModel(f.ctx, result.sessionId, f.options.nodeId, 25)).toMatchObject({ status: 'missing' })
    expect(committed).toBe(false)
    const evidence = await readExecutionModel(f.ctx, result.sessionId, f.options.nodeId)
    expect(evidence).toMatchObject({ status: 'present', kind: 'request/header' })
    expect(committed).toBe(true)
  } finally { slow.mockRestore(); await f.close() }
}, 15000)

test('does not substitute another header or unbounded accounting reads for execution evidence', async () => {
  const f = await admissionHost()
  try {
    const result = await f.seats.open({ seat: f.definition.seat, operationId: operation('header-identity'),
      origin: 'manual', openingMode: 'auto' })
    if (result.status !== 'opened') throw new Error('Expected opened Session')
    await vi.waitFor(() => { expect(f.adapter.requests).toHaveLength(1) })
    await f.ctx.get('sessionPersistence')!.flush()
    const ledger = f.ctx.get('sessionLedger')!
    const original = await ledger.snapshot({ sessionId: result.sessionId })
    const wrong = vi.spyOn(ledger, 'snapshot').mockResolvedValue({ ...original,
      rows: original.rows.map(row => row.kind === 'call'
        ? { ...row, start: { ...row.start, requestHeaderSeq: -1 } } : row) })
    try { expect(await readExecutionModel(f.ctx, result.sessionId, f.options.nodeId, 25)).toMatchObject({ status: 'missing' }) }
    finally { wrong.mockRestore() }
    const pending = Promise.withResolvers<typeof original>()
    const stalled = vi.spyOn(ledger, 'snapshot').mockReturnValue(pending.promise)
    try {
      expect(await readExecutionModel(f.ctx, result.sessionId, f.options.nodeId, 25)).toMatchObject({ status: 'missing' })
    } finally { pending.resolve(original); stalled.mockRestore() }
    expect(f.adapter.requests).toHaveLength(1)
  } finally { await f.close() }
}, 15000)

test('reads request headers after a real execution without issuing another model request', async () => {
  const f = await admissionHost()
  try {
    const result = await f.seats.open({ seat: f.definition.seat, operationId: operation('header-evidence'),
      origin: 'manual', openingMode: 'auto' })
    if (result.status !== 'opened') throw new Error('Expected opened Session')
    await vi.waitFor(async () => {
      // Request headers can be persisted before the ledger releases adapter dispatch.
      expect(f.adapter.requests).toHaveLength(1)
      await f.ctx.get('sessionPersistence')!.flush()
      expect(await readExecutionModel(f.ctx, result.sessionId, f.options.nodeId)).toMatchObject({ status: 'present',
        kind: 'request/header', provider: f.definition.provider, model: f.definition.model, sessionId: result.sessionId })
    }, { timeout: 10000 })
    expect(f.adapter.requests).toHaveLength(1)
  } finally { await f.close() }
}, 15000)
