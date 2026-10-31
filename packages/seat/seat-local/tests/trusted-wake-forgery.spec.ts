/** Deep forgeries and exactly reduced grants never admit a trusted local owner wake. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { frozenHost, sender, principalId } from './frozen-fixture.ts'
import { digest } from '../src/store.ts'

type OwnerEntry = ReturnType<T.SeatAuthorizationIssuers['register']>
type OwnerGrants = { entry: OwnerEntry; wake: T.SeatAuthorizationGrant; opening: T.SeatAuthorizationGrant }
type Fixture = Awaited<ReturnType<typeof frozenHost>> & { ownerGrants(request: T.WakeSeatRequest): Promise<OwnerGrants> }

async function setup(): Promise<Fixture> {
  const f = await frozenHost()
  await f.registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
  const definition = await f.h.seats.resolve(f.h.definition.seat)
  if ('status' in definition) throw new Error('Expected seat')
  await f.h.seats.save({ definition: { ...definition, wakeTemplate: { kind: 'text', text: 'Trusted wake' } },
    expectedRevision: 3, operationId: 'wake-template' as T.SeatOperationId })
  const ownerGrants = async (request: T.WakeSeatRequest): Promise<OwnerGrants> => {
    const entry = f.h.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
      nodeId: f.h.options.nodeId, sourceNodeId: f.h.options.nodeId, origin: 'manual', seat: request.seat, taskIds: [], policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: 'trusted-local-owner', policyRevision: 1 }) })
    const wake = await entry.issuer.check({ operationId: request.operationId, requestDigest: digest(request) })
    const opening = await entry.issuer.check({ operationId: request.operationId,
      requestDigest: digest({ ...request, origin: 'manual', openingMode: 'auto' }) })
    if ('status' in wake || 'status' in opening) throw new Error('Expected owner grants')
    return { entry, wake, opening }
  }
  return { ...f, ownerGrants }
}

function assertNoSideEffects(f: Awaited<ReturnType<typeof setup>>, send: ReturnType<typeof vi.spyOn>) {
  expect(send).not.toHaveBeenCalled()
  expect(f.h.engine.journal.projection.opens.size).toBe(0)
  expect(f.h.engine.journal.projection.pending.size).toBe(0)
  expect(f.h.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
    .filter(effect => effect.kind === 'node-wake/updated')).toHaveLength(0)
}

test.each(['counterfeit-issuer', 'foreign-issuer', 'mismatched-action'] as const)('rejects a forged opening grant: %s', async (forgery) => {
  const f = await setup()
  let entry: OwnerGrants['entry'] | undefined
  try {
    const request: T.WakeSeatRequest = { seat: f.h.definition.seat, operationId: 'forged-owner-wake' as T.SeatOperationId }
    const signed = await f.ownerGrants(request)
    entry = signed.entry
    const openingDigest = digest({ ...request, origin: 'manual', openingMode: 'auto' })
    let forged: T.SeatAuthorizationGrant
    let remoteEntry: OwnerEntry | undefined
    if (forgery === 'counterfeit-issuer') {
      // A structurally identical copy of a genuine grant is not the object this journal issued.
      forged = structuredClone(signed.opening)
    } else if (forgery === 'foreign-issuer') {
      // A live but non-owner entry signs a fully valid grant for a different admission origin.
      remoteEntry = f.h.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
        nodeId: f.h.options.nodeId, sourceNodeId: sender, origin: 'remote', seat: request.seat, taskIds: [], policyRevision: 1 },
      current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
      const foreign = await remoteEntry.issuer.check({ operationId: request.operationId, requestDigest: openingDigest })
      if ('status' in foreign) throw new Error('Expected foreign grant')
      forged = foreign
    } else {
      // The live owner entry itself signs a valid grant for a different action digest.
      const elsewhere = await signed.entry.issuer.check({ operationId: request.operationId,
        requestDigest: digest({ ...request, origin: 'manual', openingMode: 'prefill' }) })
      if ('status' in elsewhere) throw new Error('Expected mismatched grant')
      forged = elsewhere
    }
    const authority: T.SeatCallContext = { principalId, nodeId: f.h.options.nodeId, origin: 'manual',
      authorization: signed.wake, localWake: { opening: forged } }
    const send = vi.spyOn(f.h.ctx.get('messageDelivery')!, 'send')
    const result = await f.h.ctx.get('seats')!.withAuthority(authority).wake(request)
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    if (result.status === 'rejected') {
      expect(result.error.message).toBe(forgery === 'foreign-issuer'
        ? 'Local wake owner attribution differs.' : 'Local wake owner entry is revoked or mismatched.')
    }
    // The genuine opening grant alone still verifies, proving the forgery differs only in signature.
    expect(f.h.engine.authorizationIssuers.verify(signed.opening, { operationId: request.operationId,
      requestDigest: openingDigest }, f.h.options.nodeId).reasonCode).toBe('trusted-local-owner')
    assertNoSideEffects(f, send)
    remoteEntry?.dispose()
  } finally { entry?.dispose(); vi.restoreAllMocks(); await f.h.close() }
})

test.each(['wake', 'opening'] as const)('rejects an owner wake after removing its %s grant', async (removed) => {
  const f = await setup()
  let entry: OwnerGrants['entry'] | undefined
  try {
    const request: T.WakeSeatRequest = { seat: f.h.definition.seat, operationId: 'reduced-owner-wake' as T.SeatOperationId }
    const signed = await f.ownerGrants(request)
    entry = signed.entry
    const authority: T.SeatCallContext = removed === 'wake'
      ? { principalId, nodeId: f.h.options.nodeId, origin: 'manual', localWake: { opening: signed.opening } }
      : { principalId, nodeId: f.h.options.nodeId, origin: 'manual', authorization: signed.wake }
    const send = vi.spyOn(f.h.ctx.get('messageDelivery')!, 'send')
    const result = await f.h.ctx.get('seats')!.withAuthority(authority).wake(request)
    if (removed === 'wake') {
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
      if (result.status === 'rejected') expect(result.error.message).toBe('Local wake requires both owner grants.')
    } else {
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
      if (result.status === 'rejected') expect(result.error.message).toBe('Atomic wake authorization is unavailable.')
    }
    // The detached grant alone still verifies, proving every other signed fact is intact.
    const detached = removed === 'wake' ? signed.wake : signed.opening
    const payload = removed === 'wake' ? request : { ...request, origin: 'manual' as const, openingMode: 'auto' as const }
    expect(f.h.engine.authorizationIssuers.verify(detached, { operationId: request.operationId,
      requestDigest: digest(payload) }, f.h.options.nodeId).reasonCode).toBe('trusted-local-owner')
    assertNoSideEffects(f, send)
  } finally { entry?.dispose(); vi.restoreAllMocks(); await f.h.close() }
})
