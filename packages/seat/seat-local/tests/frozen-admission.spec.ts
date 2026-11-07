/** Loader-owned local admission preserves frozen acknowledgements and exact business queries. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { frozenHost, sender, principalId } from './frozen-fixture.ts'
import { digest } from '../src/store.ts'
import type { LocalSeatService } from '../src/service.ts'

test.each(['seat.openFrozen', 'seat.wakeFrozen'] as const)('%s admits a missing replay once before the late original arrives after reload', async (method) => {
  const { h, registry, request, authorize } = await frozenHost()
  try {
    const operationId = `late:${method}` as T.SeatOperationId, base = request(operationId)
    const payload = method === 'seat.openFrozen' ? base : { ...base, request: { seat: base.request.seat, operationId } }
    const original = structuredClone(payload)
    const query: T.NodeWorkChainOperationRequest = { key: { sourceNodeId: sender, principalId,
      sourceId: payload.route.sourceId, ownerEpoch: payload.route.ownerEpoch, method, operationId }, payloadDigest: digest(payload) }
    const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'] as const
    await registry.ready(methods)
    expect(await registry.query(query, await authorize(query, operationId))).toEqual({ status: 'missing' })
    const invoke = async (value: typeof payload) => {
      const seats = h.ctx.get('seats')!.withAuthority(await authorize(value, operationId))
      return method === 'seat.openFrozen' ? seats.openFrozen!(value as T.OpenFrozenSeatRequest) : seats.wakeFrozen!(value)
    }
    const replay = await invoke(payload)
    expect(replay).toMatchObject(method === 'seat.openFrozen' ? { status: 'queued' } : { status: 'opened', result: { status: 'queued' } })
    await h.reload()
    await expect.poll(() => Boolean(registry.resolve(method))).toBe(true)
    await registry.ready(methods)
    expect(await invoke(original)).toEqual(replay)
    expect(await registry.query(query, await authorize(query, operationId))).toEqual({ status: 'settled', method, result: replay })
    expect(h.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'node-route/accepted')).toHaveLength(1)
  } finally { await h.close() }
})

test.each(['seat.openFrozen', 'seat.wakeFrozen'] as const)('%s admits once and queries the original result after local reload', async (method) => {
  const { h, registry, request, authorize } = await frozenHost()
  try {
    const operationId = `frozen:${method}` as T.SeatOperationId, base = request(operationId)
    const payload = method === 'seat.openFrozen' ? base : { ...base, request: { seat: base.request.seat, operationId } }
    const invoke = async (value = payload) => {
      const seats = h.ctx.get('seats')!.withAuthority(await authorize(value, operationId))
      return method === 'seat.openFrozen' ? seats.openFrozen!(value as T.OpenFrozenSeatRequest) : seats.wakeFrozen!(value)
    }
    const queryAfterRecovery = { key: { sourceNodeId: sender, principalId, sourceId: payload.route.sourceId,
      ownerEpoch: payload.route.ownerEpoch, method, operationId }, payloadDigest: digest(payload) }
    expect(await registry.query(queryAfterRecovery, await authorize(queryAfterRecovery, 'after-recovery' as T.SeatOperationId)))
      .toEqual({ status: 'missing' })
    await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
    const first = await invoke()
    expect(first).toMatchObject(method === 'seat.openFrozen' ? { status: 'queued' } : { status: 'opened', result: { status: 'queued' } })
    expect(await invoke()).toEqual(first)
    const changed = { ...payload, openingContext: { ...payload.openingContext, openingMode: 'auto' as const } }
    expect(await invoke(changed)).toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
    const key: T.NodeWorkChainOperationKey = { sourceNodeId: sender, principalId, sourceId: payload.route.sourceId,
      ownerEpoch: payload.route.ownerEpoch, method, operationId }
    const query = { key, payloadDigest: digest(payload) }
    await expect.poll(() => ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'].map(method =>
      Boolean(registry.resolve(method as T.NodeWorkChainBusinessMethod)))).toEqual([true, true, true])
    expect(await registry.query(query, await authorize(query, 'query' as T.SeatOperationId)))
      .toEqual({ status: 'settled', method, result: first })
    await h.reload()
    await expect.poll(() => Boolean(registry.resolve('seat.openFrozen'))).toBe(true)
    await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
    expect(await registry.query(query, await authorize(query, 'query-reload' as T.SeatOperationId)))
      .toEqual({ status: 'settled', method, result: first })
    expect(await invoke()).toEqual(first)
    const retainedAuthority = await authorize(payload, operationId)
    const restricted = { ...h.definition, revision: 2 }
    expect(await h.ctx.get('seats')!.withAuthority(h.authority).save({ definition: restricted, expectedRevision: 3,
      operationId: 'revoke-remote' as T.SeatOperationId })).toMatchObject({ status: 'saved' })
    const retry = h.ctx.get('seats')!.withAuthority(retainedAuthority)
    expect(await (method === 'seat.openFrozen' ? retry.openFrozen!(payload as T.OpenFrozenSeatRequest) : retry.wakeFrozen!(payload)))
      .toEqual(first)
    expect(h.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'node-route/accepted')).toHaveLength(1)
    expect(h.adapter.requests).toHaveLength(0)
  } finally { await h.close() }
})

test.each(['seat.openFrozen', 'seat.wakeFrozen'] as const)('%s queries pre-open rejection while writes retain the first receipt across reload', async (method) => {
  const { h, registry, request, authorize } = await frozenHost()
  try {
    const operationId = `terminal:${method}` as T.SeatOperationId, base = request(operationId)
    const payload = method === 'seat.openFrozen' ? base : { ...base, request: { seat: base.request.seat, operationId } }
    const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'] as const
    await registry.ready(methods)
    const invoke = async () => {
      const seats = h.ctx.get('seats')!.withAuthority(await authorize(payload, operationId))
      return method === 'seat.openFrozen' ? seats.openFrozen!(payload as T.OpenFrozenSeatRequest) : seats.wakeFrozen!(payload)
    }
    const first = await invoke()
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    const cancellation = await h.engine.cancel({ queueItemId: pending.queueItemId,
      expectedStateVersion: pending.stateVersion, operationId: 'cancel-terminal' as T.SeatOperationId })
    expect(cancellation).toMatchObject({ status: 'cancelled' })
    const query: T.NodeWorkChainOperationRequest = { key: { sourceNodeId: sender, principalId,
      sourceId: payload.route.sourceId, ownerEpoch: payload.route.ownerEpoch, method, operationId }, payloadDigest: digest(payload) }
    for (let pass = 0; pass < 2; pass++) {
      expect(await registry.query(query, await authorize(query, operationId))).toMatchObject({ status: 'settled', method,
        result: { status: 'rejected', error: { code: 'gate-denied', retryable: false, effectState: 'none' } } })
      expect(await invoke()).toEqual(first)
      const changed = { ...query, payloadDigest: digest('changed') }
      expect(await registry.query(changed, await authorize(changed, operationId))).toMatchObject({ status: 'rejected' })
      if (!pass) { await h.reload(); await expect.poll(() => Boolean(registry.resolve(method))).toBe(true); await registry.ready(methods) }
    }
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.engine.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect => effect.kind === 'callback/pending')).toHaveLength(1)
  } finally { await h.close() }
})

test.each(['seat.openFrozen', 'seat.wakeFrozen', 'seat.openBatch', 'seat.wake'] as const)(
  '%s rejects captured writes and drains admitted work during Loader replacement', async (method) => {
    const { h, registry, request, authorize } = await frozenHost()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    try {
      const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'] as const
      await registry.ready(methods)
      const payload = request(`write-lifecycle:${method}` as T.SeatOperationId)
      const authority = await authorize(payload, payload.request.operationId)
      const original = h.ctx.get('seats')!, seats = original.withAuthority(authority)
      const resolve = original.resolve.bind(original)
      vi.spyOn(original, 'resolve').mockImplementation(async (...args) => {
        entered.resolve(undefined)
        await release.promise
        return resolve(...args)
      })
      const invoke = (target: T.SeatService) => {
        switch (method) {
          case 'seat.openFrozen': return target.openFrozen!(payload)
          case 'seat.wakeFrozen': return target.wakeFrozen!(payload)
          case 'seat.openBatch': return target.openBatch({ seats: [h.definition.seat], origin: 'remote', operationId: payload.request.operationId })
          case 'seat.wake': return target.wake({ seat: h.definition.seat, sessionId: 'missing' as import('@panedesk/dsh-session').SessionId,
            operationId: payload.request.operationId })
        }
      }
      const active = invoke(seats)
      await entered.promise
      let drained = false
      const reload = h.reload().then(() => { drained = true })
      await expect.poll(() => registry.resolve('seat.openFrozen')).toBeUndefined()
      expect(await invoke(seats)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
      expect(drained).toBe(false)
      release.resolve(undefined)
      await active
      await reload
      const replacement = h.ctx.get('seats')!.withAuthority(authority)
      expect(await invoke(replacement)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
      await registry.ready(methods)
      expect(await invoke(seats)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    } finally { release.resolve(undefined); vi.restoreAllMocks(); await h.close() }
  })

test.each(['seat.openFrozen'] as const)(
  '%s withdraws captured queries and drains calls before Loader replacement becomes ready', async (method) => {
    const { h, registry, request, authorize } = await frozenHost()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    try {
      await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
      const provider = registry.resolve(method)!
      const payload = request('query-lifecycle' as T.SeatOperationId)
      const query: T.NodeWorkChainOperationRequest = { key: { sourceNodeId: sender, principalId,
        sourceId: payload.route.sourceId, ownerEpoch: payload.route.ownerEpoch, method,
        operationId: payload.request.operationId }, payloadDigest: digest(payload) }
      const authority = await authorize(query, 'query-lifecycle-authority' as T.SeatOperationId)
      const state = (h.ctx.get('seats') as LocalSeatService).state
      const read = state.read.bind(state)
      vi.spyOn(state, 'read').mockImplementationOnce(async () => {
        entered.resolve(undefined)
        await release.promise
        return read()
      })
      const active = provider.query(query, authority)
      await entered.promise
      let drained = false
      const reloading = h.reload().then(() => { drained = true })
      await expect.poll(() => registry.resolve(method) === provider).toBe(false)
      expect(await provider.query(query, authority)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
      expect(drained).toBe(false)
      release.resolve(undefined)
      expect(await active).toEqual({ status: 'missing' })
      await reloading
      await expect.poll(() => Boolean(registry.resolve(method))).toBe(true)
      const replacement = registry.resolve(method)!
      expect(replacement).not.toBe(provider)
      expect(await replacement.query(query, authority)).toEqual({ status: 'pending', effectState: 'unknown' })
      expect(await registry.query(query, authority)).toEqual({ status: 'pending', effectState: 'unknown' })
      await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
      expect(await registry.query(query, authority)).toEqual({ status: 'missing' })
      expect(await provider.query(query, authority)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    } finally { release.resolve(undefined); vi.restoreAllMocks(); await h.close() }
  })
