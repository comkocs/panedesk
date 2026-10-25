/** Authorized cancellation retains durable attribution without allocating window resources. */
import { afterEach, expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { harness, trigger, nodeId, seat, auto } from './fixtures.ts'
import { canonical, digest } from '../src/journal.ts'
import { decodeAuthorizationFrame } from '../src/authorization-storage.ts'
import { redact } from '../src/query.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
async function setup() { const h = await harness({ ownerObserveIntervalMs: 60000 }); cleanups.push(h.close); return h }
async function issue(engine: Awaited<ReturnType<typeof harness>>['engine'], request: T.CancelPendingSeatRequest) {
  const registration = engine.authorizationIssuers.register({ identity: { kind: 'local-operator',
    principalId: 'operator-a' as T.SeatPrincipalId, origin: 'manual', nodeId, seat, taskIds: [], policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'authenticated-local-operator', policyRevision: 1 }) })
  const grant = await registration.issuer.check({ operationId: request.operationId, requestDigest: digest(request) })
  if ('status' in grant) throw new Error('Expected grant')
  return { grant, dispose: () => { registration.dispose() } }
}
async function pendingRequest(h: Awaited<ReturnType<typeof harness>>, reason?: string) {
  await h.engine.accept(trigger())
  const pending = (await h.engine.pending({ limit: 10 })).items[0]!
  return { queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
    operationId: 'cancel-a' as T.SeatOperationId, ...(reason === undefined ? {} : { reason }) }
}
it.each([false, true])('cancels approved=%s work without creating or changing budget and resource projections', async (approved) => {
  const h = await setup(), request = await pendingRequest(h, 'Operator stopped pending work')
  if (approved) {
    await h.engine.approve({ ...request, operationId: 'approve-a' as T.SeatOperationId })
    request.expectedStateVersion++
  }
  const before = { budgets: [...h.engine.journal.projection.budgets], resources: [...h.engine.journal.projection.resources] }
  const { grant } = await issue(h.engine, request)
  const result = await h.engine.authorizations.cancel(request, grant)
  expect(result).toEqual({ status: 'cancelled', queueItemId: request.queueItemId, stateVersion: request.expectedStateVersion + 1 })
  const frame = h.engine.journal.projection.authorizationDecisions.at(-1)!
  expect(frame.effects.map(effect => effect.kind)).toEqual(['queue/cancelled', 'authorization/checked'])
  expect(decodeAuthorizationFrame(canonical(frame), h.engine.options.config.maxDecisionBytes)).toEqual(frame)
  const receipt = await h.engine.authorizations.operation(request)
  expect(receipt).toMatchObject({ status: 'settled', result: { status: 'cancelled', cancellation: {
    authorizationId: grant.fact.authorizationId, principalId: 'operator-a', kind: 'local-operator',
    queueItemId: request.queueItemId, operationId: request.operationId, reason: request.reason, reasonPresent: true,
    stateVersion: request.expectedStateVersion + 1 } } })
  if (receipt.status !== 'settled' || !('cancellation' in receipt.result)) throw new Error('Expected cancellation receipt')
  expect(Number.isFinite(Date.parse(receipt.result.cancellation.cancelledAt))).toBe(true)
  const effect = h.engine.journal.projection.decisions.at(-1)!.effects[0]!
  expect(JSON.stringify(redact(effect))).not.toContain(request.reason)
  expect(redact(effect)).toMatchObject({ data: { cancellation: { reasonPresent: true } } })
  const sequence = h.engine.journal.projection.sequence
  expect(await h.engine.authorizations.cancel(request, grant)).toEqual(result)
  expect(h.engine.journal.projection.sequence).toBe(sequence)
  await h.engine.shutdown()
  const restarted = await h.start()
  expect(await restarted.authorizations.operation(request)).toEqual(receipt)
  const fresh = await issue(restarted, request)
  expect(await restarted.authorizations.cancel(request, fresh.grant)).toEqual(result)
  expect({ budgets: [...restarted.journal.projection.budgets], resources: [...restarted.journal.projection.resources] }).toEqual(before)
  await restarted.drive()
  expect(h.creates).toEqual([])
})
it('keeps legacy cancellation replies and absent attribution byte-for-byte', async () => {
  const h = await setup(), request = await pendingRequest(h)
  expect(JSON.stringify(await h.engine.cancel(request))).toBe(JSON.stringify({ status: 'cancelled',
    queueItemId: request.queueItemId, stateVersion: request.expectedStateVersion + 1 }))
  expect(JSON.stringify(await h.engine.cancel(request))).toBe(JSON.stringify({ status: 'rejected', error: {
    code: 'revision-conflict', message: 'Pending state changed', alternative: 'Inspect engine state and retry with the same operation identity.',
    retryable: false, effectState: 'none' } }))
  const effect = h.engine.journal.projection.decisions.at(-1)!.effects[0]!
  expect(effect).toMatchObject({ data: { principalId: 'engine-policy' } })
  expect(effect.data).not.toHaveProperty('cancellation')
})
it('rejects changed reasons, revoked grants and overlong or control-character reasons before mutation', async () => {
  const h = await setup(), request = await pendingRequest(h, 'Original reason')
  const issued = await issue(h.engine, request)
  expect(await h.engine.authorizations.cancel({ ...request, reason: 'Changed reason' }, issued.grant)).toMatchObject({ status: 'rejected' })
  issued.dispose()
  expect(await h.engine.authorizations.cancel(request, issued.grant)).toMatchObject({ status: 'rejected' })
  for (const reason of ['a'.repeat(513), '\n', String.fromCodePoint(0x85), 'é'.repeat(257)]) {
    const invalid = { ...request, reason }, { grant } = await issue(h.engine, invalid)
    expect(await h.engine.authorizations.cancel(invalid, grant)).toMatchObject({ status: 'rejected', error: { code: 'invalid-request' } })
  }
  expect((await h.engine.pending({ limit: 10 })).items).toHaveLength(1)
})
it('distinguishes unknown, dispatched and opened targets without changing legacy errors', async () => {
  const h = await setup(), request = await pendingRequest(h)
  const unknown = { ...request, queueItemId: 'unknown' as T.QueueItemId }
  expect(await h.engine.authorizations.cancel(unknown, (await issue(h.engine, unknown)).grant)).toMatchObject({
    status: 'rejected', error: { code: 'revision-conflict', cause: { reasonCode: 'queue-item-unknown' } } })
  await auto(h.engine)
  let release!: () => void, started!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve }), dispatched = new Promise<void>((resolve) => { started = resolve })
  const create = h.executor.create.bind(h.executor)
  h.executor.create = async (open) => { started(); await blocked; return create(open) }
  const driving = h.engine.drive()
  try {
    await dispatched
    expect(await h.engine.authorizations.cancel(request, (await issue(h.engine, request)).grant)).toMatchObject({
      status: 'rejected', error: { cause: { reasonCode: 'queue-item-dispatched' } } })
  } finally { release(); await driving }
  expect(await h.engine.authorizations.cancel(request, (await issue(h.engine, request)).grant)).toMatchObject({
    status: 'rejected', error: { cause: { reasonCode: 'queue-item-opened' } } })
  expect(await h.engine.cancel(request)).toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
})
