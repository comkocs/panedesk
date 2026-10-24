/** Issued local actions use real journal admission and preserve legacy observations. */
import { afterEach, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { digest } from '@panedesk/dsh-seat-engine'
import { SeatEngineReader } from '../../seat-engine/src/reader.ts'
import { Context } from '@panedesk/cordis'
import { engineFixture } from './engine-fixture.ts'
import { LocalCloser } from '../src/closing-service.ts'
import { operation } from './fixtures.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'authorized-actions-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const f = await engineFixture(true, root)
  cleanups.push(() => f.close())
  const opened = await f.open()
  if (opened.status !== 'opened') throw new Error('Expected an active window')
  const registration = f.engine.authorizationIssuers.register({ identity: { kind: 'local-operator',
    principalId: 'operator-a' as T.SeatPrincipalId, origin: 'manual', nodeId: f.options.nodeId,
    seat: f.definition.seat, taskIds: [], policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'authenticated-test-entry', policyRevision: 1 }) })
  cleanups.push(async () => { registration.dispose() })
  const issue = async (request: { operationId: T.SeatOperationId }) => {
    const grant = await registration.issuer.check({ operationId: request.operationId, requestDigest: digest(request) })
    if ('status' in grant) throw new Error('Expected an issued grant')
    return grant
  }
  return { ...f, sessionId: opened.sessionId, issue, registration, root }
}

test('commits renewal and replacement intents with grants and rejects forged or changed replay evidence', async () => {
  const f = await setup(), actions = f.ctx.get('seatAuthorizedEngineActions')!
  const renewal = { sessionId: f.sessionId, operationId: operation('renew-authorized') }
  const grant = await f.issue(renewal)
  expect(await actions.renew(renewal, JSON.parse(JSON.stringify(grant)) as T.SeatAuthorizationGrant))
    .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
  expect(f.renewals).toHaveLength(0)
  const [renewed, concurrent] = await Promise.all([actions.renew(renewal, grant), actions.renew(renewal, grant)])
  expect(renewed, JSON.stringify(renewed)).toMatchObject({ status: 'renewed' })
  expect(['renewed', 'uncertain']).toContain(concurrent.status)
  expect(await actions.renew(renewal, grant)).toMatchObject({ status: 'renewed' })
  expect(f.renewals).toEqual([renewal.operationId])
  expect(await actions.renew({ ...renewal, source: 'auto' }, grant)).toMatchObject({ status: 'rejected' })
  const replacement = { sessionId: f.sessionId, operationId: operation('replace-authorized') }
  expect(await actions.replace(replacement, await f.issue(replacement))).toMatchObject({ status: 'queued' })
  const frames = f.engine.journal.projection.authorizationDecisions.filter(frame =>
    frame.effects.some(effect => effect.kind === 'authorization/checked'))
  expect(frames).toHaveLength(2)
  expect(frames[0]!.effects.map(effect => effect.kind)).toEqual(['cache/keepalive', 'authorization/checked'])
  expect(frames[1]!.effects.map(effect => effect.kind)).toEqual(['window/replacement', 'queue/pending', 'authorization/checked'])
  f.registration.dispose()
  expect(await actions.renew(renewal, grant)).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
})

test('commits close admission and exports issued facts after restarting the writer', async () => {
  const f = await setup()
  const request = { sessionId: f.sessionId, operationId: operation('close-authorized'), expectedStateVersion: 1 }
  const closer = new LocalCloser(f.ctx, f.state, f.runtime, f.options)
  expect(await closer.close(request, undefined, await f.issue(request))).toMatchObject({ status: 'closed' })
  const frame = f.engine.journal.projection.authorizationDecisions.find(frame =>
    frame.effects.some(effect => effect.kind === 'authorization/checked'))!
  expect(frame.effects.map(effect => effect.kind)).toEqual(['window/closing', 'authorization/checked'])
  const before = await f.ctx.get('seatAuthorizationExports')!.export({ limit: 10 })
  expect(before).toMatchObject({ format: 'seat-authorization/v1', complete: true })
  expect((await f.engine.query({ limit: 100 })).effects.map(effect => effect.kind)).not.toContain('authorization/checked')
  await f.engine.shutdown()
  const restarted = await engineFixture(true, f.root)
  cleanups.push(() => restarted.close())
  expect(await restarted.ctx.get('seatAuthorizationExports')!.export({ limit: 10 })).toEqual(before)
  const reader = new Context()
  cleanups.push(() => reader.fiber.dispose())
  new SeatEngineReader(reader, { home: f.root, nodeId: f.options.nodeId, maxDecisionBytes: 200000 })
  expect(await reader.get('seatAuthorizationExports')!.export({ limit: 10 })).toEqual(before)
})

test('failed close admission retains neither authorization nor a close barrier', async () => {
  const f = await setup()
  const request = { sessionId: f.sessionId, operationId: operation('close-conflict'), expectedStateVersion: 99 }
  const closer = new LocalCloser(f.ctx, f.state, f.runtime, f.options)
  expect(await closer.close(request, undefined, await f.issue(request))).toMatchObject({ status: 'conflict' })
  expect(await f.engine.authorizations.query({ limit: 10 })).toMatchObject({ facts: [] })
  expect((await f.engine.query({ limit: 100 })).effects.some(effect => effect.kind === 'window/closing')).toBe(false)
})
