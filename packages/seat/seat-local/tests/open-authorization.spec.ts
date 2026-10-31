/** Alternate opening entries retain issued authority and never select legacy admission. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { AuthorizationIssuers } from '@panedesk/dsh-seat-engine/src/authorization-issuer.ts'
import { admissionHost } from './admission-host.ts'
import { engineFixture } from './engine-fixture.ts'
import { operation } from './fixtures.ts'
import { admitLocalOpen } from '../src/open-admission.ts'
import { digest } from '../src/store.ts'

const reference: T.OpeningContextReference = { providerId: 'authority-test' as T.OpeningProviderId,
  reference: 'task-a' as T.OpeningContextReference['reference'], revision: '1' }
const taskId = 'task-a' as T.SeatTaskId
const incomplete = 'Local wake opening requires the checked wake entry'
const unsupported = 'This engine does not support authorized opening admission.'
const damages = ['missing-wake', 'missing-opening', 'foreign', 'revoked', 'digest', 'clone'] as const
const entries = ['open', 'openWithContext', 'openBatch', 'prefill', 'wake', 'wakeWithContext'] as const

async function signed(issuers: T.SeatAuthorizationIssuers, authority: T.SeatCallContext, request: T.OpenSeatRequest | T.WakeSeatRequest) {
  const entry = issuers.register({ identity: { kind: 'node-delegation', principalId: authority.principalId,
    nodeId: authority.nodeId, sourceNodeId: authority.nodeId, origin: 'manual', seat: request.seat,
    taskIds: [taskId], policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'trusted-local-owner', policyRevision: 1 }) })
  const grant = await entry.issuer.check({ operationId: request.operationId, requestDigest: digest(request) })
  if ('status' in grant) throw new Error('Expected issued authority')
  return { entry, grant }
}

for (const entry of entries) test.each(damages)(`${entry} rejects %s authority without business effects`, async (damage) => {
  const f = await admissionHost()
  const disposers: (() => void)[] = []
  try {
    const wake = entry === 'wake' || entry === 'wakeWithContext'
    const request: T.OpenSeatRequest = { seat: f.definition.seat, origin: 'manual',
      openingMode: entry === 'prefill' ? 'prefill' : 'auto', operationId: operation('invalid-opening'), taskId }
    const wakeRequest: T.WakeSeatRequest = { seat: request.seat, operationId: request.operationId }
    const batch: T.OpenSeatBatchRequest = { seats: [request.seat], origin: 'manual', openingMode: 'auto',
      operationId: request.operationId }
    const payload: T.OpenSeatRequest | T.WakeSeatRequest = wake ? wakeRequest : entry === 'openBatch'
      ? { ...batch, seat: request.seat, operationId: operation(`${batch.operationId}:${request.seat}`) } : request
    const valid = await signed(f.engine.authorizationIssuers, f.authority, payload)
    disposers.push(() => { valid.entry.dispose() })
    const opening = await signed(f.engine.authorizationIssuers, f.authority,
      { ...wakeRequest, origin: 'manual', openingMode: 'auto' })
    disposers.push(() => { opening.entry.dispose() })
    let authorization = valid.grant
    if (damage === 'foreign') {
      const foreign = await signed(new AuthorizationIssuers(), f.authority, payload)
      authorization = foreign.grant; disposers.push(() => { foreign.entry.dispose() })
    } else if (damage === 'revoked') valid.entry.dispose()
    else if (damage === 'clone') authorization = structuredClone(valid.grant)
    else if (damage === 'digest') {
      const mismatch = await valid.entry.issuer.check({ operationId: request.operationId, requestDigest: digest('another action') })
      if ('status' in mismatch) throw new Error('Expected mismatched authority')
      authorization = mismatch
    }
    const authority: T.SeatCallContext = { ...f.authority,
      ...(damage === 'missing-wake' ? {} : { authorization }),
      ...(wake || damage === 'missing-wake' ? { localWake: { opening: opening.grant } } : {}) }
    if (damage === 'missing-opening') {
      delete authority.localWake
      // The remaining wake grant is not an opening grant, even when its fields are otherwise valid.
      if (!wake) {
        const wakeOnly = await signed(f.engine.authorizationIssuers, f.authority,
          { seat: request.seat, operationId: payload.operationId })
        authority.authorization = wakeOnly.grant; disposers.push(() => { wakeOnly.entry.dispose() })
      }
    }
    const contexts = f.ctx.get('seatOpeningContexts')!
    const release = contexts.register({ providerId: reference.providerId, resolve: async () => ({ reference,
      text: 'Frozen authority test', digest: digest('Frozen authority test'), revision: '1', taskIds: [taskId], scopeEvidence: [] }) })
    const send = vi.spyOn(f.ctx.get('messageDelivery')!, 'send')
    const before = (await f.state.read()).effects.filter(effect => effect.kind !== 'source/rejected')
    const seats = f.ctx.get('seats')!.withAuthority(authority)
    let result: T.OpenSeatResult | T.WakeSeatResult
    if (entry === 'openWithContext') result = await contexts.open({ ...request, openingContext: reference, relatedTaskIds: [taskId] }, authority)
    else if (entry === 'wakeWithContext') result = await contexts.wake!({ ...wakeRequest, openingContext: reference, relatedTaskIds: [taskId] }, authority)
    else if (entry === 'wake') result = await seats.wake(wakeRequest)
    else if (entry === 'openBatch') {
      const processed = await seats.openBatch(batch)
      expect(processed.status).toBe('processed')
      if (processed.status !== 'processed') throw new Error('Expected member result')
      result = processed.results[0]!.result
    } else result = await seats.open(request)
    const message = wake ? damage === 'missing-wake' ? 'Local wake requires both owner grants.'
      : damage === 'missing-opening' ? 'Atomic wake authorization is unavailable.'
        : 'Local wake owner entry is revoked or mismatched.'
      : damage === 'missing-wake' ? incomplete
        : damage === 'digest' || damage === 'missing-opening' ? 'Authorization grant does not match this action'
          : 'Authorization grant is foreign, revoked or stale'
    expect(result).toMatchObject({ status: 'rejected', error: { message, effectState: 'none' } })
    expect((await f.state.read()).effects.filter(effect => effect.kind !== 'source/rejected')).toEqual(before)
    expect(f.engine.journal.projection.opens.size).toBe(0)
    expect(f.engine.journal.projection.pending.size).toBe(0)
    expect(await f.ctx.sessionPersistence.list()).toEqual([])
    expect(send).not.toHaveBeenCalled()
    expect(f.adapter.requests).toEqual([])
    await release()
  } finally { for (const dispose of disposers) dispose(); vi.restoreAllMocks(); await f.close() }
})

for (const entry of ['open', 'openWithContext', 'prefill', 'openBatch'] as const) {
  test.each(['principal', 'node', 'seat', 'context-tasks'] as const)(`${entry} rejects live grants with mismatched %s without business effects`, async (binding) => {
    const f = await admissionHost()
    const disposers: (() => void | Promise<void>)[] = []
    try {
      const otherTask = 'task-b' as T.SeatTaskId
      const request: T.OpenSeatRequest = { seat: f.definition.seat, origin: 'manual',
        openingMode: entry === 'prefill' ? 'prefill' : 'auto', operationId: operation('bound-opening') }
      const batch: T.OpenSeatBatchRequest = { seats: [request.seat], origin: 'manual', openingMode: 'auto',
        operationId: request.operationId }
      const payload = entry === 'openBatch'
        ? { ...batch, seat: request.seat, operationId: operation(`${batch.operationId}:${request.seat}`) } : request
      const issuer = f.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation',
        principalId: binding === 'principal' ? 'other-user' as T.SeatPrincipalId : f.authority.principalId,
        nodeId: binding === 'node' ? 'other-node' as T.SeatNodeId : f.authority.nodeId,
        sourceNodeId: f.authority.nodeId, origin: 'manual',
        seat: binding === 'seat' ? 'other-seat' as T.SeatName : request.seat, taskIds: [taskId], policyRevision: 1 },
      current: () => ({ decision: 'allowed', reasonCode: 'trusted-local-owner', policyRevision: 1 }) })
      disposers.push(() => { issuer.dispose() })
      const grant = await issuer.issuer.check({ operationId: payload.operationId, requestDigest: digest(payload) })
      if ('status' in grant) throw new Error('Expected live issued authority')
      expect(f.engine.authorizationIssuers.verify(grant,
        { operationId: payload.operationId, requestDigest: digest(payload) }, grant.fact.nodeId)).toEqual(grant.fact)
      const authority: T.SeatCallContext = { ...f.authority, authorization: grant }
      const snapshot: T.OpeningContextSnapshot = { reference, text: 'Frozen binding test',
        digest: digest('Frozen binding test'), revision: '1',
        taskIds: binding === 'context-tasks' ? [taskId, otherTask] : [taskId], scopeEvidence: [] }
      const contexts = f.ctx.get('seatOpeningContexts')!
      disposers.push(contexts.register({ providerId: reference.providerId, resolve: async () => snapshot }))
      if (binding === 'context-tasks' && entry !== 'openWithContext') {
        // These public requests have no context field; exercise their shared checked engine entry with a frozen context.
        const openWindow = f.engine.openWindow.bind(f.engine)
        vi.spyOn(f.engine, 'openWindow').mockImplementation(input => openWindow({ ...input, openingContext: snapshot }))
      }
      const before = (await f.state.read()).effects.filter(effect => effect.kind !== 'source/rejected')
      const send = vi.spyOn(f.ctx.get('messageDelivery')!, 'send')
      const seats = f.ctx.get('seats')!.withAuthority(authority)
      let result: T.OpenSeatResult
      if (entry === 'openWithContext') {
        result = await contexts.open({ ...request, openingContext: reference, relatedTaskIds: snapshot.taskIds }, authority)
      } else if (entry === 'openBatch') {
        const processed = await seats.openBatch(batch)
        expect(processed.status).toBe('processed')
        if (processed.status !== 'processed') throw new Error('Expected member result')
        result = processed.results[0]!.result
      } else result = await seats.open(request)
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'unauthorized',
        message: binding === 'node' ? 'Authorization grant does not match this action'
          : 'Opening attribution does not authorize this seat and task', effectState: 'none' } })
      expect((await f.state.read()).effects.filter(effect => effect.kind !== 'source/rejected')).toEqual(before)
      expect(f.engine.journal.projection.opens.size).toBe(0)
      expect(f.engine.journal.projection.pending.size).toBe(0)
      expect(await f.ctx.sessionPersistence.list()).toEqual([])
      expect(send).not.toHaveBeenCalled()
      expect(f.adapter.requests).toEqual([])
    } finally { for (const dispose of disposers) await dispose(); vi.restoreAllMocks(); await f.close() }
  })
}

test.each(['authorization', 'localWake', 'both'] as const)('legacy engine rejects %s without calling accept', async (fields) => {
  const f = await engineFixture()
  try {
    const authority: T.SeatCallContext = { principalId: 'user-a' as T.SeatPrincipalId, nodeId: f.options.nodeId, origin: 'manual' }
    const request: T.OpenSeatRequest = { seat: f.definition.seat, origin: 'manual', operationId: operation('legacy-authorized') }
    const { entry, grant } = await signed(f.engine.authorizationIssuers, authority, request)
    if (fields !== 'localWake') authority.authorization = grant
    if (fields !== 'authorization') authority.localWake = { opening: grant }
    const accept = vi.spyOn(f.engine, 'accept')
    Object.defineProperty(f.engine, 'openWindow', { value: undefined, configurable: true })
    const before = await f.state.read()
    const result = await admitLocalOpen(f.engine, f.state, { request, authority, definition: f.definition,
      opening: { text: 'Frozen opening', digest: digest('Frozen opening'), variables: { seat: f.definition.seat, date: '2026-01-01', taskId: null } }, title: 'Opening' }, f.options.nodeName)
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'unavailable', message: unsupported } })
    expect(accept).not.toHaveBeenCalled()
    expect(await f.state.read()).toEqual(before)
    expect(f.created).toEqual([])
    entry.dispose()
  } finally { vi.restoreAllMocks(); await f.close() }
})

test.each(['open', 'openBatch'] as const)('%s preserves authority when the engine lacks openWindow', async (entry) => {
  const f = await admissionHost()
  try {
    const request: T.OpenSeatRequest = { seat: f.definition.seat, origin: 'manual', openingMode: 'auto',
      operationId: operation('unsupported-opening') }
    const { entry: issuer, grant } = await signed(f.engine.authorizationIssuers, f.authority, request)
    issuer.dispose()
    const seats = f.ctx.get('seats')!.withAuthority({ ...f.authority, authorization: grant })
    const accept = vi.spyOn(f.engine, 'accept'), before = await f.state.read()
    Object.defineProperty(f.engine, 'openWindow', { value: undefined, configurable: true })
    const result = entry === 'open' ? await seats.open(request)
      : await seats.openBatch({ seats: [request.seat], origin: 'manual', operationId: request.operationId })
    const refusal = { status: 'rejected', error: { code: 'unavailable', message: unsupported } }
    expect(result).toMatchObject(entry === 'open' ? refusal : { status: 'processed', results: [{ result: refusal }] })
    expect(accept).not.toHaveBeenCalled()
    expect(await f.state.read()).toEqual(before)
    expect(await f.ctx.sessionPersistence.list()).toEqual([])
    expect(f.adapter.requests).toEqual([])
  } finally { vi.restoreAllMocks(); await f.close() }
})

test.each(['auto', 'prefill'] as const)('direct openWindow refuses reduced local wake in %s mode', async (openingMode) => {
  const f = await engineFixture()
  try {
    const authority: T.SeatCallContext = { principalId: 'user-a' as T.SeatPrincipalId, nodeId: f.options.nodeId, origin: 'manual' }
    const request: T.OpenSeatRequest = { seat: f.definition.seat, origin: 'manual', openingMode, operationId: operation('reduced-wake') }
    const { entry, grant } = await signed(f.engine.authorizationIssuers, authority, request)
    authority.localWake = { opening: grant }
    const before = await f.state.read()
    expect(await f.engine.openWindow({ request, authority, definition: f.definition,
      opening: { text: 'Frozen opening', digest: digest('Frozen opening'), variables: { seat: f.definition.seat, date: '2026-01-01', taskId: null } }, title: 'Opening' }))
      .toMatchObject({ status: 'rejected', error: { code: 'unauthorized', message: incomplete } })
    expect(await f.state.read()).toEqual(before)
    expect(f.created).toEqual([])
    entry.dispose()
  } finally { await f.close() }
})

test('direct openWindow cannot consume the internal converted wake authority', async () => {
  const f = await engineFixture()
  try {
    const authority: T.SeatCallContext = { principalId: 'user-a' as T.SeatPrincipalId, nodeId: f.options.nodeId, origin: 'manual' }
    const request: T.OpenSeatRequest = { seat: f.definition.seat, origin: 'manual', operationId: operation('converted-wake') }
    const { entry, grant } = await signed(f.engine.authorizationIssuers, authority, request)
    authority.authorization = grant
    authority.localWake = { opening: grant }
    const before = await f.state.read()
    expect(await f.engine.openWindow({ request, authority, definition: f.definition,
      opening: { text: 'Frozen opening', digest: digest('Frozen opening'), variables: { seat: f.definition.seat, date: '2026-01-01', taskId: null } }, title: 'Opening' }))
      .toMatchObject({ status: 'rejected', error: { code: 'unauthorized', message: incomplete } })
    expect(await f.state.read()).toEqual(before)
    expect(f.created).toEqual([])
    entry.dispose()
  } finally { await f.close() }
})

test('authorized prefill replay retains its admitted window after grant revocation', async () => {
  const f = await admissionHost()
  try {
    const request: T.OpenSeatRequest = { seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
      operationId: operation('authorized-replay') }
    const { entry, grant } = await signed(f.engine.authorizationIssuers, f.authority, request)
    const seats = f.ctx.get('seats')!.withAuthority({ ...f.authority, authorization: grant })
    const first = await seats.open(request)
    expect(first.status).toBe('prefilled')
    entry.dispose()
    const replay = await seats.open(request)
    expect(replay).toMatchObject({ status: 'prefilled', ...('sessionId' in first ? { sessionId: first.sessionId } : {}) })
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(1)
    expect(f.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'trigger/accepted')).toHaveLength(1)
    expect(f.adapter.requests).toEqual([])
  } finally { await f.close() }
})

test('checked context wake retains both grants through its internal opening conversion', async () => {
  const f = await admissionHost()
  try {
    const request: T.WakeSeatRequest = { seat: f.definition.seat, operationId: operation('context-wake') }
    const wake = await signed(f.engine.authorizationIssuers, f.authority, request)
    const opening = await signed(f.engine.authorizationIssuers, f.authority, { ...request, origin: 'manual', openingMode: 'auto' })
    const authority: T.SeatCallContext = { ...f.authority, authorization: wake.grant, localWake: { opening: opening.grant } }
    const contexts = f.ctx.get('seatOpeningContexts')!
    const release = contexts.register({ providerId: reference.providerId, resolve: async () => ({ reference,
      text: 'Frozen authority test', digest: digest('Frozen authority test'), revision: '1', taskIds: [taskId], scopeEvidence: [] }) })
    const result = await contexts.wake!({ ...request, openingContext: reference, relatedTaskIds: [taskId] }, authority)
    expect(result).toMatchObject({ status: 'opened', result: { status: 'opened' } })
    expect(f.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'authorization/checked')).toMatchObject([{ data: { reasonCode: 'trusted-local-owner' } }])
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(1)
    wake.entry.dispose(); opening.entry.dispose(); await release()
  } finally { await f.close() }
})

test('legacy engine still accepts an entirely unsigned trusted opening and its replay', async () => {
  const f = await engineFixture()
  try {
    Object.defineProperty(f.engine, 'openWindow', { value: undefined, configurable: true })
    const first = await f.open('legacy-control')
    expect(first.status).toBe('opened')
    expect(await f.open('legacy-control')).toMatchObject({ status: 'opened', ...('sessionId' in first ? { sessionId: first.sessionId } : {}) })
    expect(f.created).toHaveLength(1)
  } finally { await f.close() }
})
