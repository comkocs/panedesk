/** Loader-backed source ingress persists exact intents without allocating local execution resources. */
import { expect, test } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { EngineJournal, digest } from '@panedesk/dsh-seat-engine'
import { decodeFrame, canonical } from '@panedesk/dsh-seat-engine/src/journal.ts'
import { sourceProxyRecords } from '@panedesk/dsh-seat-engine/src/source-proxy-storage.ts'
import { admissionHost } from './admission-host.ts'
import { composition, remoteNode, proxySource } from './source-proxy-composition.ts'

const request = (id: string): T.OpenSeatWithContextRequest => ({ seat: 'seat-a' as T.SeatName,
  operationId: id as T.SeatOperationId, origin: 'manual', nodeId: remoteNode, relatedTaskIds: [],
  openingContext: { providerId: 'source-provider' as T.OpeningProviderId,
    reference: 'source-reference' as T.OpeningContextReference['reference'], revision: '1' } })

test('routes open and wake with fresh composition grants after durable source reservation', async () => {
  const h = await admissionHost(), c = await composition(h.engine, h.ctx.get('storageDomain')!, h.ctx)
  const dispose = h.engine.registerSourceProxy(c.port)
  try {
    const opening = h.ctx.get('seatOpeningContexts')!, input = request('remote-open')
    const authority = await c.grant(input)
    const [first, second] = await Promise.all([opening.open(input, authority), opening.open(input, authority)])
    expect(first).toMatchObject({ status: 'queued' })
    expect(second).toEqual(first)
    expect(c.state.sends).toBe(1)
    const { origin: _origin, ...wake } = request('remote-wake')
    expect(await opening.wake!(wake, await c.grant(wake))).toMatchObject({ status: 'opened', result: { status: 'queued' } })
    expect(c.grants).toHaveLength(2)
    expect(new Set(c.grants.map(grant => grant.fact.authorizationId)).size).toBe(2)
    expect(c.grants[0]).not.toBe(c.originals[0])
    expect(c.grants[0]?.fact.requestDigest).not.toBe(c.originals[0]?.fact.requestDigest)
    expect(c.originals[0]).toBe(authority.authorization)
    expect(h.engine.journal.projection.resources.size).toBe(0)
    expect(h.engine.journal.projection.pending.size).toBe(0)
    expect(h.adapter.requests).toHaveLength(0)
    const records = [...sourceProxyRecords(h.engine.journal.projection.authorizationDecisions).values()]
    expect(records.map(record => record.outcome.status)).toEqual(['committed', 'committed'])
    expect(records[0]?.input).toEqual(input)
    expect(records[0]?.operationKey).toMatchObject({ sourceNodeId: h.options.nodeId, method: 'seat.openFrozen' })
    const frame = h.engine.journal.projection.authorizationDecisions.find(frame => frame.effects.some(effect => effect.kind === 'node-source/updated'))!
    expect(() => decodeFrame(canonical(frame), h.engine.options.config.maxDecisionBytes)).toThrow()
    await h.reload()
    expect(await h.ctx.get('seatOpeningContexts')!.open(input, authority)).toEqual(first)
    expect(c.state.sends).toBe(2)
  } finally { await dispose(); await c.close(); await h.close() }
})

test('retains unknown and rejected outcomes on exact retry and journal recovery', async () => {
  const h = await admissionHost(), c = await composition(h.engine, h.ctx.get('storageDomain')!, h.ctx)
  const dispose = h.engine.registerSourceProxy(c.port)
  try {
    const opening = h.ctx.get('seatOpeningContexts')!, unknown = request('unknown'), authority = await c.grant(unknown)
    c.state.unknown = true
    expect(await opening.open(unknown, authority)).toMatchObject({ status: 'rejected', error: { effectState: 'unknown' } })
    expect(await opening.open(unknown, authority)).toMatchObject({ error: { effectState: 'unknown' } })
    expect(c.state.sends).toBe(1)
    const changed = { ...unknown, openingContext: { ...unknown.openingContext, revision: '2' } }
    expect(await opening.open(changed, await c.grant(changed))).toMatchObject({ error: { code: 'operation-id-conflict' } })
    c.state.unknown = false; c.state.reject = true
    const denied = request('denied'), deniedAuthority = await c.grant(denied)
    const refusal = await opening.open(denied, deniedAuthority)
    expect(refusal).toMatchObject({ error: { code: 'gate-denied', effectState: 'none' } })
    expect(await opening.open(denied, deniedAuthority)).toEqual(refusal)
    expect(c.state.sends).toBe(2)
    await dispose(); await h.engine.shutdown()
    const journal = new EngineJournal(h.engine.journal.root, h.options.nodeId, h.engine.options.config.maxDecisionBytes)
    await journal.ready()
    try {
      const records = [...sourceProxyRecords(journal.projection.authorizationDecisions).values()]
      expect(records.map(record => record.outcome.status)).toEqual(['unknown', 'rejected'])
      expect(records[0]?.payload.openingContext.scopeReservation.reservationId).toBe('source-reservation')
      expect(journal.projection.resources.size).toBe(0)
    } finally { await journal.close() }
  } finally { await dispose(); await c.close(); await h.close() }
})

test('routes registered trigger input without resolving target locally and rejects foreign original grants', async () => {
  const h = await admissionHost(), c = await composition(h.engine, h.ctx.get('storageDomain')!, h.ctx)
  const dispose = h.engine.registerSourceProxy(c.port)
  try {
    const unregister = h.engine.registerSource({ sourceId: proxySource, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
    h.ctx.effect(() => unregister)
    const envelope: T.TriggerEnvelope = { triggerId: 'trigger' as T.TriggerId, eventId: 'event' as T.SourceEventId,
      sourceId: proxySource, kind: 'external', evidence: { kind: 'external', eventType: 'event' },
      seat: h.definition.seat, projectId: h.definition.projectId, receivedAt: '2026-01-01T00:00:00Z',
      data: null, dataDigest: digest(null), callbackRef: proxySource }
    expect(await h.engine.accept(envelope)).toMatchObject({ status: 'accepted' })
    expect(await h.engine.accept(envelope)).toMatchObject({ status: 'accepted' })
    expect(c.state.sends).toBe(1)
    const input = request('forged'), authority = await c.grant(input)
    const before = h.engine.journal.projection.sequence
    expect(await h.ctx.get('seatOpeningContexts')!.open(input, { ...authority,
      authorization: { ...authority.authorization } })).toMatchObject({ error: { code: 'unauthorized' } })
    expect(h.engine.journal.projection.sequence).toBe(before)
  } finally { await dispose(); await c.close(); await h.close() }
})

test.each(['principal', 'node', 'seat', 'tasks'] as const)('source proxy refuses live %s mismatch before reserving or sending', async (binding) => {
  const h = await admissionHost(), c = await composition(h.engine, h.ctx.get('storageDomain')!, h.ctx)
  const dispose = h.engine.registerSourceProxy(c.port)
  const tasks = ['task-a', 'task-b'] as T.SeatTaskId[]
  const prepare = c.port.prepare.bind(c.port)
  c.port.prepare = async (input) => {
    const result = await prepare(input)
    if (!('status' in result)) {
      result.payload.openingContext.snapshot.taskIds = tasks
      result.payload.openingContext.scopeReservation.taskIds = tasks
    }
    return result
  }
  try {
    const input = { ...request('source-binding'), relatedTaskIds: tasks }
    const registration = h.engine.authorizationIssuers.register({ identity: { kind: 'human', origin: 'manual',
      principalId: h.authority.principalId, nodeId: binding === 'node' ? remoteNode : h.options.nodeId,
      seat: binding === 'seat' ? 'other-seat' as T.SeatName : input.seat,
      taskIds: binding === 'tasks' ? tasks.slice(0, 1) : tasks, policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
    const check = { operationId: input.operationId, requestDigest: digest(input) }
    const authorization = await registration.issuer.check(check)
    if ('status' in authorization) throw new Error('Expected live source authority')
    expect(h.engine.authorizationIssuers.verify(authorization, check, authorization.fact.nodeId)).toEqual(authorization.fact)
    const authority = { ...h.authority, authorization,
      principalId: binding === 'principal' ? 'other-principal' as T.SeatPrincipalId : h.authority.principalId }
    const before = await h.state.read()
    const result = await h.ctx.get('seatOpeningContexts')!.open(input, authority)
    expect(result).toMatchObject({ status: 'rejected', error: {
      code: binding === 'seat' || binding === 'tasks' ? 'engine-store-corrupt' : 'unauthorized', effectState: 'none',
      message: binding === 'principal' ? 'Source authority differs from the local entry'
        : binding === 'node' ? 'Authorization grant does not match this action' : 'Invalid outgoing frozen intent' } })
    expect(await h.state.read()).toEqual(before)
    expect(c.state.sends).toBe(0)
    expect(c.grants).toEqual([])
    expect(sourceProxyRecords(h.engine.journal.projection.authorizationDecisions).size).toBe(0)
    expect(h.engine.journal.projection.resources.size).toBe(0)
    expect(h.adapter.requests).toEqual([])
    registration.dispose()
  } finally { await dispose(); await c.close(); await h.close() }
})

test('reconciles an unknown intent without preparing again and drains source disposal', async () => {
  const h = await admissionHost(), c = await composition(h.engine, h.ctx.get('storageDomain')!, h.ctx)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const send = c.port.send.bind(c.port)
  c.port.send = async (input) => { entered.resolve(undefined); await release.promise; return send(input) }
  c.state.unknown = true
  const dispose = h.engine.registerSourceProxy(c.port)
  try {
    const input = request('draining'), authority = await c.grant(input)
    const first = h.ctx.get('seatOpeningContexts')!.open(input, authority)
    await entered.promise
    let drained = false
    const closing = dispose().then(() => { drained = true })
    expect(await h.ctx.get('seatOpeningContexts')!.open(request('after-dispose'), authority))
      .toMatchObject({ error: { code: 'unavailable' } })
    expect(drained).toBe(false)
    release.resolve(undefined)
    expect(await first).toMatchObject({ error: { effectState: 'unknown' } })
    await closing
    c.port.reconcile = async (record) => {
      expect(record.input).toEqual(input)
      expect(c.intents.get(digest(record.operationKey))).toBeDefined()
      return c.reconcile(record)
    }
    const restored = h.engine.registerSourceProxy(c.port)
    try {
      expect(await h.ctx.get('seatOpeningContexts')!.open(input, authority)).toMatchObject({ status: 'queued' })
      expect(c.state.prepares).toBe(1)
      expect(c.state.sends).toBe(1)
      expect(c.grants).toHaveLength(2)
      expect(c.grants[1]?.fact.authorizationId).not.toBe(c.grants[0]?.fact.authorizationId)
      expect(c.grants[1]?.fact.requestDigest).not.toBe(c.grants[0]?.fact.requestDigest)
    } finally { await restored() }
  } finally { release.resolve(undefined); await dispose(); await c.close(); await h.close() }
})

test('keeps absent source composition on the legacy remote refusal without new source records', async () => {
  const h = await admissionHost()
  try {
    expect(await h.ctx.get('seatOpeningContexts')!.open(request('uninstalled'), h.authority))
      .toMatchObject({ status: 'rejected', error: { code: 'cross-node-unsupported', effectState: 'none' } })
    expect(sourceProxyRecords(h.engine.journal.projection.authorizationDecisions).size).toBe(0)
    expect(h.engine.journal.projection.resources.size).toBe(0)
    expect(h.adapter.requests).toHaveLength(0)
  } finally { await h.close() }
})
