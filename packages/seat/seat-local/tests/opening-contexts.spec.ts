/** Source freezing and rejection use the real Loader, engine and local execution chain. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import * as Gates from '../../seat-gates/src/index.ts'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { digest } from '../src/store.ts'

const reference: T.OpeningContextReference = { providerId: 'desk' as T.OpeningProviderId,
  reference: 'task-a' as T.OpeningContextReference['reference'], revision: '1' }
const taskId = 'task-a' as T.SeatTaskId
function snapshot(text = 'Original first line\n{{seat}} retained verbatim\n'): T.OpeningContextSnapshot {
  return { reference, text, digest: digest(text), revision: '1', taskIds: [taskId], scopeEvidence: [] }
}
it('freezes source text, prefills without starting a turn and replays after reload or disposal without rereading', async () => {
  const f = await admissionHost()
  try {
    const contexts = f.ctx.get('seatOpeningContexts')!
    const resolve = vi.fn(async () => snapshot())
    const release = contexts.register({ providerId: reference.providerId, resolve })
    const request: T.OpenSeatWithContextRequest = { seat: f.definition.seat, operationId: operation('context-a'),
      origin: 'manual', openingMode: 'prefill', openingContext: reference, relatedTaskIds: [taskId] }
    const first = await contexts.open(request, f.authority)
    expect(first).toMatchObject({ status: 'prefilled', draft: snapshot().text })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]).toEqual([reference, f.authority])
    expect(f.adapter.requests).toHaveLength(0)
    const facts = (await f.state.read()).effects
    expect(facts.find(effect => effect.kind === 'trigger/accepted')).toMatchObject({ data: {
      pending: { relatedTaskIds: [taskId], frozenOpen: { openingContext: snapshot() } } } })
    await release()
    expect(await contexts.open(request, f.authority)).toMatchObject({ status: 'prefilled', draft: snapshot().text,
      ...('sessionId' in first ? { sessionId: first.sessionId } : {}) })
    expect(await contexts.open({ ...request, relatedTaskIds: [] }, f.authority)).toMatchObject({ error: { code: 'operation-id-conflict' } })
    await f.reload()
    expect(await f.ctx.get('seatOpeningContexts')!.open(request, f.authority)).toMatchObject({ status: 'prefilled', draft: snapshot().text })
    expect(await contexts.open(request, f.authority)).toMatchObject({ error: { code: 'unavailable' } })
    expect(() => contexts.register({ providerId: reference.providerId, resolve })).toThrow('unavailable')
    expect(resolve).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})
it('rejects missing sources or mismatched digests before durable admission and creation', async () => {
  const f = await admissionHost()
  try {
    const contexts = f.ctx.get('seatOpeningContexts')!
    const request: T.OpenSeatWithContextRequest = { seat: f.definition.seat, operationId: operation('bad-context'),
      origin: 'manual', openingContext: reference, relatedTaskIds: [taskId] }
    const before = (await f.state.read()).watermark
    expect(await contexts.open(request, f.authority)).toMatchObject({ error: { code: 'unavailable' } })
    const release = contexts.register({ providerId: reference.providerId,
      resolve: async () => ({ ...snapshot(), digest: digest('Different body text') }) })
    expect(await contexts.open(request, f.authority)).toMatchObject({ error: { code: 'invalid-request' } })
    expect((await f.state.read()).watermark).toBe(before)
    expect(f.adapter.requests).toHaveLength(0)
    await release()
  } finally { await f.close() }
})
it('rejects unknown batch scopes or missing checks with a serial alternative and no member creation', async () => {
  const f = await admissionHost()
  try {
    const contexts = f.ctx.get('seatOpeningContexts')!
    const tasks: T.SeatTaskScopeContext[] = [{ taskId, seat: f.definition.seat, nodeId: f.options.nodeId,
      scopeEvidenceRef: 'scope-a' as T.SeatTaskScopeContext['scopeEvidenceRef'],
      scopeEvidence: { status: 'unknown', taskId, reason: 'Authority omitted required fields', alternative: 'serial' } }]
    const request: T.OpenSeatBatchWithScopeRequest = { seats: [f.definition.seat], origin: 'manual',
      operationId: operation('scope-batch'), tasks }
    const before = (await f.state.read()).watermark
    expect(await contexts.openBatch(request, f.authority)).toMatchObject({ error: { code: 'gate-denied', alternative: 'serial' } })
    f.ctx.loader.builtins.gates = Gates
    const ready = Promise.withResolvers<undefined>()
    f.ctx.inject(['seatGates'], () => { ready.resolve(undefined) })
    await f.load('scope-gates.yml', [{ name: 'cordis:gates' }]); await ready.promise
    expect(await contexts.openBatch(request, f.authority)).toMatchObject({ error: { message: 'scope-unknown', alternative: 'serial' } })
    expect((await f.state.read()).watermark).toBe(before)
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})
it('drains active resolutions during source disposal and immediately rejects new resolutions', async () => {
  const f = await admissionHost()
  try {
    const contexts = f.ctx.get('seatOpeningContexts')!
    const started = Promise.withResolvers<undefined>(), pending = Promise.withResolvers<T.OpeningContextSnapshot>()
    const release = contexts.register({ providerId: reference.providerId,
      resolve: async () => { started.resolve(undefined); return pending.promise } })
    const request: T.OpenSeatWithContextRequest = { seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
      operationId: operation('drain'), openingContext: reference, relatedTaskIds: [taskId] }
    const active = contexts.open(request, f.authority)
    await started.promise
    let drained = false
    const disposing = release().then(() => { drained = true })
    expect(await contexts.open({ ...request, operationId: operation('late') }, f.authority)).toMatchObject({ error: { code: 'unavailable' } })
    expect(drained).toBe(false)
    pending.resolve(snapshot())
    expect(await active).toMatchObject({ status: 'prefilled' })
    await disposing
    expect(drained).toBe(true)
  } finally { await f.close() }
})
