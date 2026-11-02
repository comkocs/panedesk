/** Protected-input decisions use authenticated owner transport even between turns. */
import { Context } from '@panedesk/cordis'
import { SessionId } from '@panedesk/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '../../../test-support/agent-loop-testkit/src/index.ts'
import Gateway from '../../../api/gateway/src/index.ts'
import TypertRegistry from '../../../typert/registry/src/index.ts'
import RemoteAccess from '../../../api/remote-access/src/index.ts'
import * as Remotes from '../../../api/remotes/src/index.ts'
import { Peer, apply as applyConnection, inject as connectionInject } from '../../../client/connection/src/index.ts'
import { provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import type { RemoteEventDownlinkFrame } from '../../../api/gateway/src/stream-protocol.ts'
import ApprovalService, { type ApprovalOutcome, setApprovalPolicy } from '../src/index.ts'

const purpose = { type: 'protected-input', path: '/project/profile/patch.yml', previous: 'old-digest', current: 'new-digest' } as const

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(ApprovalService, { workspaceWriteTimeoutMs: 1000 })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('protected-input-owner'), {}, { cwd: '/project' })
  provideBrowserCredentials(ctx)
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await ctx.plugin(Remotes)
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const controller = new AbortController()
  const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, controller.signal)
  const events = stream[Symbol.asyncIterator]() as AsyncIterator<RemoteEventDownlinkFrame>
  const first = await events.next()
  if (first.done || first.value.type !== 'ready') throw new Error('Owner stream did not become ready')
  const clientId = first.value.clientId
  onTestFinished(async () => { controller.abort(); await events.return?.(); await peer.dispose() })
  const reply = async (eventId: string, value: ApprovalOutcome, sender = peer) => {
    const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://localhost/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: eventId, method: '$events/result',
        payload: { args: { clientId, eventId, outcome: { kind: 'result', value } } } }),
    }), sender)
    return response.json() as Promise<{ result: { ok: boolean } }>
  }
  return { ctx, agent, events, reply, peer }
}

it.each(['allowed-once', 'rejected'] as const)('records an idle owner decision without starting a model turn: %s', async (outcome) => {
  const f = await fixture()
  const request = f.ctx.approval.requestProtectedInput(f.agent, purpose)
  const frame = await f.events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected protected-input approval')
  expect(frame.value.request.purpose).toEqual(purpose)
  expect((await f.reply(frame.value.eventId, outcome)).result.ok).toBe(true)
  expect(await request).toBe(outcome)
  expect(f.agent.status).toBe('idle')
  expect(f.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  expect(f.agent.inbox).toBeDefined()
})

it('does not prompt an unattended session and retains a passive refusal notice', async () => {
  const f = await fixture()
  setApprovalPolicy(f.agent.session, 'never')
  const transport = vi.spyOn(f.ctx.typertGateway, 'requestOwnerEvent')
  const notice = vi.spyOn(f.agent, 'inject')
  expect(await f.ctx.approval.requestProtectedInput(f.agent, purpose)).toBe('rejected')
  expect(transport).not.toHaveBeenCalled()
  expect(notice).toHaveBeenCalledOnce()
  expect(f.agent.status).toBe('idle')
})

it('rejects an SDK automation connection even when it borrows an owner principal', async () => {
  const f = await fixture()
  const request = f.ctx.approval.requestProtectedInput(f.agent, purpose)
  const frame = await f.events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected protected-input approval')
  const automation = new Peer(f.ctx, { principal: { kind: 'owner' }, interactions: 'none' })
  onTestFinished(() => automation.dispose())
  expect(await f.reply(frame.value.eventId, 'allowed-once', automation)).toMatchObject({
    result: { ok: false, error: { code: 'gateway/interactions-forbidden' } },
  })
  expect((await f.reply(frame.value.eventId, 'rejected')).result.ok).toBe(true)
  expect(await request).toBe('rejected')
})

it('ignores model Host listeners and rejects replies from a different owner connection', async () => {
  const f = await fixture()
  const forged = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
  f.ctx.on('approval/request', forged, { prepend: true })
  const request = f.ctx.approval.requestProtectedInput(f.agent, purpose)
  const frame = await f.events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected protected-input approval')
  const other = new Peer(f.ctx, { principal: { kind: 'owner' } })
  onTestFinished(() => other.dispose())
  expect((await f.reply(frame.value.eventId, 'allowed-once', other)).result.ok).toBe(false)
  expect(forged).not.toHaveBeenCalled()
  expect((await f.reply(frame.value.eventId, 'rejected')).result.ok).toBe(true)
  expect(await request).toBe('rejected')
})
