/** Required authorization facts commit and recover with their original action. */
import { rename, writeFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { canonical, decodeFrame, digest } from '../src/journal.ts'
import { decodeAuthorizationFrame } from '../src/authorization-storage.ts'
import { AuthorizationIssuers } from '../src/authorization-issuer.ts'
import { queryLegacyAuthorizations, queryTasks } from '../src/authorization-query.ts'
import { harness, nodeId, projectId, seat, trigger } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup() { const h = await harness(); cleanups.push(h.close); return h }
const taskId = 'task-a' as T.SeatTaskId
function request(id = 'action-a', expectedSequence = 0): T.SeatAuthorizationTransactionRequest {
  return { operationId: id as T.SeatOperationId, decisionId: `decision:${id}` as T.EngineDecisionId,
    expectedSequence, requestDigest: digest(id) }
}
function entry(kind: T.SeatIssuedAuthorizationKind = 'human'): T.SeatAuthorizationEntry {
  return { identity: { kind, principalId: 'principal-a' as T.SeatPrincipalId, origin: 'manual', nodeId,
    seat, taskIds: [taskId], policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'trusted-entry', policyRevision: 1 }) }
}
async function grant(issuers: AuthorizationIssuers, input: T.SeatAuthorizationCheck, kind: T.SeatIssuedAuthorizationKind = 'human') {
  const { operationId, requestDigest, callId, rootCallId } = input
  const value = await issuers.register(entry(kind)).issuer.check({ operationId, requestDigest,
    ...(callId ? { callId } : {}), ...(rootCallId ? { rootCallId } : {}) })
  if ('status' in value) throw new Error('Expected an issued grant')
  return value
}
function effects(input: T.SeatAuthorizationCheck): T.EngineEffect[] {
  return [{ kind: 'mode/changed', eventId: `event:${input.operationId}` as T.EngineEventId, operationId: input.operationId,
    data: { policy: { projectId, mode: 'auto', modeChosen: true, revision: 1 }, previousMode: 'remind', previousRevision: 0,
      principalId: 'principal-a' as T.SeatPrincipalId } }]
}

describe('atomic issued authorization', () => {
  it('approves with the original queue transition and its attribution in one decision', async () => {
    const h = await setup()
    const accepted = await h.engine.accept({ ...trigger(), taskId })
    if (accepted.status !== 'accepted') throw new Error('Expected pending work')
    const pending = (await h.engine.pending({ limit: 10 })).items[0]!
    const approval = { queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
      operationId: 'approve-a' as T.SeatOperationId }
    const authorization = await grant(h.engine.authorizationIssuers, { operationId: approval.operationId, requestDigest: digest(approval) }, 'local-operator')
    const result = await h.engine.authorizations.approve(approval, authorization)
    expect(result).toMatchObject({ status: 'approved', stateVersion: pending.stateVersion + 1 })
    expect(h.engine.journal.projection.authorizationDecisions.at(-1)?.effects.map(effect => effect.kind))
      .toEqual(['queue/approved', 'authorization/checked'])
    const watermark = h.engine.journal.projection.sequence
    expect(await h.engine.authorizations.approve(approval, authorization)).toEqual(result)
    expect(h.engine.journal.projection.sequence).toBe(watermark)
    const conflict = { ...approval, operationId: 'approve-b' as T.SeatOperationId }
    const other = await grant(h.engine.authorizationIssuers, { operationId: conflict.operationId, requestDigest: digest(conflict) })
    expect(await h.engine.authorizations.approve(conflict, other)).toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
    expect(h.engine.journal.projection.sequence).toBe(watermark)
    const deniedRequest = { ...approval, operationId: 'approve-denied' as T.SeatOperationId }
    const deniedIssuer = h.engine.authorizationIssuers.register({ ...entry(),
      current: () => ({ decision: 'denied', reasonCode: 'policy-denied', policyRevision: 1 }) }).issuer
    const denied = await deniedIssuer.check({ operationId: deniedRequest.operationId, requestDigest: digest(deniedRequest) })
    if ('status' in denied) throw new Error('Expected denied grant')
    const refusal = await h.engine.authorizations.approve(deniedRequest, denied)
    expect(refusal).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(await h.engine.authorizations.approve(deniedRequest, denied)).toEqual(refusal)
    expect(h.engine.journal.projection.sequence).toBe(watermark + 1)
  })

  it('retains no committed authorization after append failure and recovers a complete frame before projection publication', async () => {
    const h = await setup(), input = request(), authorization = await grant(h.engine.authorizationIssuers, input)
    const events = join(h.engine.journal.root, 'events')
    await rename(events, `${events}-saved`)
    await writeFile(events, 'Unavailable storage')
    expect(await h.engine.authorizations.transact(input, () => ({ authorization, effects: effects(input) })))
      .toMatchObject({ status: 'rejected', error: { effectState: 'unknown' } })
    expect(h.engine.journal.projection.sequence).toBe(0)
    const other = await setup(), otherInput = request()
    const original = other.engine.journal.projection.applyAuthorization.bind(other.engine.journal.projection)
    other.engine.journal.projection.applyAuthorization = () => { throw new Error('Crash after fsync') }
    const otherGrant = await grant(other.engine.authorizationIssuers, otherInput)
    expect(await other.engine.authorizations.transact(otherInput, () => ({ authorization: otherGrant, effects: effects(otherInput) })))
      .toMatchObject({ status: 'rejected', error: { effectState: 'unknown' } })
    other.engine.journal.projection.applyAuthorization = original
    expect(other.engine.journal.projection.sequence).toBe(0)
    await other.engine.shutdown()
    const restarted = await other.start()
    expect(await restarted.authorizations.query({ taskId, limit: 10 })).toMatchObject({ facts: [otherGrant.fact], watermark: 1 })
    const names = await readdir(join(restarted.journal.root, 'events'))
    expect(names).toHaveLength(1)
    const bytes = await readFile(join(restarted.journal.root, 'events', names[0]!), 'utf8')
    expect(decodeAuthorizationFrame(bytes.trimEnd(), restarted.options.config.maxDecisionBytes).effects).toHaveLength(2)
  })

  it('persists denied checks without admitting business effects and rejects malformed durable attribution', async () => {
    const h = await setup(), input = request()
    const issuer = h.engine.authorizationIssuers.register({ ...entry(), current: () => ({ decision: 'denied', reasonCode: 'policy-denied', policyRevision: 1 }) }).issuer
    const authorization = await issuer.check({ operationId: input.operationId, requestDigest: input.requestDigest })
    if ('status' in authorization) throw new Error('Expected denied audit grant')
    expect(await h.engine.authorizations.transact(input, () => ({ authorization, effects: effects(input) }))).toMatchObject({ status: 'rejected' })
    expect(await h.engine.authorizations.transact(input, () => ({ authorization, effects: [] }))).toMatchObject({ status: 'committed' })
    expect(await h.engine.authorizations.query({ limit: 10 })).toMatchObject({ facts: [{ decision: 'denied' }] })
    const frame = h.engine.journal.projection.authorizationDecisions[0]!
    expect(() => decodeAuthorizationFrame(canonical({ ...frame, digest: 'invalid' }), h.engine.options.config.maxDecisionBytes)).toThrow('checksum')
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(await restarted.authorizations.query({ limit: 10 })).toMatchObject({ facts: [{ decision: 'denied' }] })
  })

  it('commits action and attribution in one frame and rebuilds task, seat and kind queries after restart', async () => {
    const h = await setup(), input = request()
    const authorization = await grant(h.engine.authorizationIssuers, input)
    const result = await h.engine.authorizations.transact(input, () => ({ authorization, effects: effects(input) }))
    expect(result).toMatchObject({ status: 'committed', sequence: 1 })
    const frames = h.engine.journal.projection.authorizationDecisions
    expect(frames).toHaveLength(1)
    expect(frames[0]?.effects.map(effect => effect.kind)).toEqual(['mode/changed', 'authorization/checked'])
    const before = await h.engine.authorizations.query({ taskId, seat, kind: 'human', limit: 10 })
    expect(before).toMatchObject({ facts: [authorization.fact], watermark: 1, complete: true })
    expect(() => decodeFrame(canonical(frames[0]), h.engine.options.config.maxDecisionBytes)).toThrow('Invalid engine effect')
    expect(decodeAuthorizationFrame(canonical(frames[0]), h.engine.options.config.maxDecisionBytes)).toEqual(frames[0])
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(await restarted.authorizations.query({ taskId, seat, kind: 'human', limit: 10 })).toEqual(before)
    expect(await restarted.authorizations.transact(input, () => { throw new Error('Replay must not rebuild') })).toEqual(result)
    expect(await restarted.authorizations.transact({ ...input, requestDigest: digest('different') }, () => {
      throw new Error('Conflicting replay must not rebuild')
    })).toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
  })

  it('rejects forged, foreign, revoked, stale and caller-attributed grants without committing actions', async () => {
    const h = await setup(), input = request()
    const registration = h.engine.authorizationIssuers.register(entry())
    expect(await registration.issuer.check({ ...input, kind: 'engine' } as T.SeatAuthorizationCheck)).toMatchObject({ status: 'rejected' })
    const issued = await grant(h.engine.authorizationIssuers, input)
    const forged = JSON.parse(JSON.stringify(issued)) as T.SeatAuthorizationGrant
    const foreign = await grant(new AuthorizationIssuers(), input)
    for (const authorization of [forged, foreign]) {
      expect(await h.engine.authorizations.transact(input, () => ({ authorization, effects: effects(input) })))
        .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    }
    const check = { operationId: input.operationId, requestDigest: input.requestDigest }
    const revoked = await registration.issuer.check(check)
    if ('status' in revoked) throw new Error('Expected a grant')
    registration.dispose()
    expect(await h.engine.authorizations.transact(input, () => ({ authorization: revoked, effects: effects(input) })))
      .toMatchObject({ status: 'rejected' })
    let revision = 1
    const policy = h.engine.authorizationIssuers.register({ ...entry(), current: () => ({ decision: 'allowed', reasonCode: 'trusted-entry', policyRevision: revision }) })
    const stale = await policy.issuer.check(check)
    if ('status' in stale) throw new Error('Expected a grant')
    revision++
    expect(await h.engine.authorizations.transact(input, () => ({ authorization: stale, effects: effects(input) })))
      .toMatchObject({ status: 'rejected' })
    expect(h.engine.journal.projection.sequence).toBe(0)
  })

  it('leaves neither action nor fact after a failed builder or malformed intent and reports sequence conflicts', async () => {
    const h = await setup(), input = request(), authorization = await grant(h.engine.authorizationIssuers, input)
    await expect(h.engine.authorizations.transact(input, () => { throw new Error('Action failed') })).rejects.toThrow('Action failed')
    expect(await h.engine.authorizations.transact(input, () => ({ authorization, effects: [] }))).toMatchObject({ status: 'rejected' })
    expect(await h.engine.authorizations.transact(input, () => ({ authorization, effects: effects(request('other')) }))).toMatchObject({ status: 'rejected' })
    const unrelated = { ...effects(request('unrelated'))[0]!, operationId: undefined }
    expect(await h.engine.authorizations.transact(input, () => ({ authorization, effects: [...effects(input), unrelated] })))
      .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(await h.engine.authorizations.query({ limit: 10 })).toMatchObject({ facts: [], watermark: 0 })
    expect(await h.engine.authorizations.transact({ ...input, expectedSequence: 1 }, () => { throw new Error('CAS precedes builder') }))
      .toEqual({ status: 'conflict', sequence: 0 })
  })

  it('advances scanned cursors across filtered plugin facts without widening the legacy vocabulary', async () => {
    const h = await setup()
    for (const [index, kind] of ['plugin', 'human', 'plugin', 'local-operator', 'engine'].entries()) {
      const input = request(`action-${index}`, index)
      const authorization = await grant(h.engine.authorizationIssuers, input, kind as T.SeatIssuedAuthorizationKind)
      expect(await h.engine.authorizations.transact(input, () => ({ authorization, effects: effects(input) }))).toMatchObject({ status: 'committed' })
    }
    const page = await h.engine.authorizations.query({ kind: 'plugin', limit: 1 })
    if ('status' in page) throw new Error('Expected query results')
    expect(page).toMatchObject({ facts: [{ kind: 'plugin' }], complete: false, watermark: 5, nextCursor: { sequence: 1, effectIndex: 1 } })
    const next = await h.engine.authorizations.query({ kind: 'plugin', cursor: page.nextCursor!, limit: 10 })
    expect(next).toMatchObject({ facts: [{ kind: 'plugin' }], complete: true, watermark: 5, nextCursor: { sequence: 5, effectIndex: 1 } })
    const taskDecisions = h.engine.journal.projection.decisions.map(decision => ({ ...decision,
      effects: decision.effects.map(effect => ({ ...effect, taskId })) }))
    const taskPage = queryTasks(taskDecisions, { taskId, limit: 2 })
    expect(taskPage).toMatchObject({ complete: false, watermark: 5, nextCursor: { sequence: 2, effectIndex: 0 } })
    expect(taskPage.effects).toHaveLength(2)
    expect(queryTasks(taskDecisions, { taskId, limit: 10, cursor: taskPage.nextCursor! }).effects).toHaveLength(3)
    expect(() => queryTasks(taskDecisions, { taskId, limit: 0 })).toThrow('positive')
    const legacy = queryLegacyAuthorizations(h.engine.journal.projection.authorizationDecisions, { limit: 10 })
    expect(legacy.facts.map(data => data.kind)).toEqual(['human', 'local-operator', 'engine'])
    expect(await h.engine.authorizations.query({ taskId: 'missing' as T.SeatTaskId, limit: 10 }))
      .toMatchObject({ facts: [], complete: true, nextCursor: { sequence: 5, effectIndex: 1 } })
    expect(await h.engine.authorizations.query({ limit: 1, cursor: { nodeId, sequence: 99, effectIndex: 0 } }))
      .toMatchObject({ status: 'rejected', error: { code: 'query-cursor-invalid' } })
  })
})
