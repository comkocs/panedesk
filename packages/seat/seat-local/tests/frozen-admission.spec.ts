/** Loader-owned local admission preserves frozen acknowledgements and exact business queries. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { frozenHost, sender, principalId } from './frozen-fixture.ts'
import { digest } from '../src/store.ts'

test.each(['seat.openFrozen', 'seat.wakeFrozen'] as const)('%s admits once and queries the original result after local reload', async (method) => {
  const { h, registry, request, authorize } = await frozenHost()
  try {
    const operationId = `frozen:${method}` as T.SeatOperationId, base = request(operationId)
    const payload = method === 'seat.openFrozen' ? base : { ...base, request: { seat: base.request.seat, operationId } }
    const invoke = async (value = payload, withSender = true) => {
      const seats = h.ctx.get('seats')!.withAuthority(await authorize(value, operationId, withSender))
      return method === 'seat.openFrozen' ? seats.openFrozen!(value as T.OpenFrozenSeatRequest) : seats.wakeFrozen!(value)
    }
    const before = h.engine.journal.projection.sequence
    expect(await invoke(payload, false)).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(h.engine.journal.projection.sequence).toBe(before)
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
    const queryAuthority = await authorize(query, 'before-ready' as T.SeatOperationId)
    expect(await registry.query(query, queryAuthority)).toEqual({ status: 'pending', effectState: 'unknown' })
    await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
    expect(await registry.query(query, await authorize(query, 'query' as T.SeatOperationId)))
      .toEqual({ status: 'settled', method, result: first })
    await h.reload()
    await expect.poll(() => Boolean(registry.resolve('seat.openFrozen'))).toBe(true)
    await registry.ready(['seat.openFrozen', 'seat.wakeFrozen'])
    expect(await registry.query(query, await authorize(query, 'query-reload' as T.SeatOperationId)))
      .toEqual({ status: 'settled', method, result: first })
    expect(await invoke()).toEqual(first)
    const retainedAuthority = await authorize(payload, operationId)
    const restricted = { ...h.definition, revision: 2 }
    expect(await h.ctx.get('seats')!.withAuthority(h.authority).save({ definition: restricted, expectedRevision: 3,
      operationId: 'revoke-remote' as T.SeatOperationId })).toMatchObject({ status: 'saved' })
    h.engine.authorizationIssuers.close()
    const retry = h.ctx.get('seats')!.withAuthority(retainedAuthority)
    expect(await (method === 'seat.openFrozen' ? retry.openFrozen!(payload as T.OpenFrozenSeatRequest) : retry.wakeFrozen!(payload)))
      .toEqual(first)
    expect(h.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'node-route/accepted')).toHaveLength(1)
    expect(h.adapter.requests).toHaveLength(0)
  } finally { await h.close() }
})

test.each(['engine.acceptFrozen', 'seat.openFrozen'] as const)(
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
      const validate = h.engine.authorizations.validate.bind(h.engine.authorizations)
      vi.spyOn(h.engine.authorizations, 'validate').mockImplementation(async (...args) => {
        entered.resolve(undefined)
        await release.promise
        return validate(...args)
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
