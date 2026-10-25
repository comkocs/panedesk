/** The real local provider exposes source operations only while their owner is registered. */
import { expect, test } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { rejected } from '../src/errors.ts'
import { digest } from '../src/store.ts'

function requests(nodeId: T.SeatNodeId, seat: T.SeatName) {
  const sourceId = 'source-owner' as T.SeatSourceId, ownerEpoch = 'owner-epoch' as T.OwnerEpoch
  const operationId = operation('source-owner')
  const route: T.NodeWorkChainRoute = { sourceId, sourceOwnerNodeId: nodeId, ownerEpoch,
    triggerId: null, originalOperationId: operationId, targetNodeId: nodeId, snapshotDigest: digest('opening'),
    callbackPath: { kind: 'source', sourceId }, modeCeiling: { mode: 'remind',
      policy: { sourceId, projectId: 'project' as T.SeatProjectId, revision: 1 } } }
  const prepare: T.PrepareSourceOpeningRequest = { sourceId, sourceOwnerNodeId: nodeId, ownerEpoch,
    reference: { providerId: 'provider' as T.OpeningProviderId, reference: 'reference' as T.OpeningContextReference['reference'], revision: '1' },
    seat, taskIds: [], operationId, targetNodeId: nodeId, expectedSeatRevision: 1, openingMode: 'prefill' }
  const admission: T.CheckSourceAdmissionRequest = { route, taskIds: [], operationId, executionNodeId: nodeId,
    scopeReservation: { sourceId, sourceOwnerNodeId: nodeId, ownerEpoch, operationId, taskIds: [],
      snapshotDigest: route.snapshotDigest, policyRevision: 1, reservationId: 'reservation' as T.NodeWorkChainScopeReservation['reservationId'] } }
  const payload: T.SeatCallbackPayload = { kind: 'opened', callbackId: 'callback' as T.CallbackId, sourceId,
    triggerId: null, stateVersion: 1, seat, title: 'title', sessionId: 'session' as NonNullable<T.SeatCallbackPayload['sessionId']>,
    nodeId, nodeName: 'node', budget: {}, relatedTaskIds: [] }
  const body = { callback: payload, route, modelEvidence: { status: 'missing' as const,
    sessionId: payload.sessionId, nodeId, observedAt: new Date().toISOString() } }
  return { prepare, admission, callback: { ...body, payloadDigest: digest(body) } }
}

test('forwards all source operations, rejects duplicate owners and drains disposal without exposing stale methods', async () => {
  const f = await admissionHost()
  try {
    const contexts = f.ctx.get('seatOpeningContexts')!
    expect('prepare' in contexts).toBe(false)
    expect('checkAdmission' in contexts).toBe(false)
    expect('deliverCallback' in contexts).toBe(false)
    const input = requests(f.options.nodeId, f.definition.seat)
    const gate = Promise.withResolvers<T.PrepareSourceOpeningResult>()
    const entered = Promise.withResolvers<undefined>()
    const owner: T.SeatSourceOwner = {
      prepare: async (request, authority) => {
        expect(request).toBe(input.prepare)
        expect(authority).toBe(f.authority)
        entered.resolve(undefined)
        return gate.promise
      },
      checkAdmission: async (request, authority) => {
        expect(request).toBe(input.admission)
        expect(authority).toBe(f.authority)
        return { status: 'allowed', policyRevision: 1 }
      },
      deliverCallback: async (request, authority) => {
        expect(request).toBe(input.callback)
        expect(authority).toBe(f.authority)
        return { status: 'committed', callbackId: request.callback.callbackId, payloadDigest: request.payloadDigest }
      },
    }
    const release = contexts.registerSourceOwner!(owner)
    expect(() => contexts.registerSourceOwner!(owner)).toThrow('already registered')
    expect(await contexts.checkAdmission!(input.admission, f.authority)).toEqual({ status: 'allowed', policyRevision: 1 })
    expect(await contexts.deliverCallback!(input.callback, f.authority)).toMatchObject({ status: 'committed' })
    const captured = contexts.prepare!.bind(contexts)
    const pending = captured(input.prepare, f.authority)
    await entered.promise
    let drained = false
    const disposing = release().then(() => { drained = true })
    expect('prepare' in contexts).toBe(false)
    expect('checkAdmission' in contexts).toBe(false)
    expect('deliverCallback' in contexts).toBe(false)
    expect(await captured(input.prepare, f.authority)).toMatchObject({ status: 'rejected' })
    expect(drained).toBe(false)
    expect(() => contexts.registerSourceOwner!(owner)).toThrow('already registered')
    gate.resolve(rejected('unavailable', 'Retained refusal', 'Retry later'))
    expect(await pending).toMatchObject({ status: 'rejected', error: { message: 'Retained refusal' } })
    await disposing
    expect(drained).toBe(true)
    const releaseAgain = contexts.registerSourceOwner!(owner)
    await f.reload()
    expect('prepare' in contexts).toBe(false)
    expect('prepare' in f.ctx.get('seatOpeningContexts')!).toBe(false)
    await releaseAgain()
  } finally { await f.close() }
})
