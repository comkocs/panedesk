import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity, type ProfileContext } from '@panedesk/dsh-app-boot'
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
import ApprovalService, { type ApprovalOutcome } from '../src/index.ts'

async function fixture(cwd: string) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(ApprovalService, { workspaceWriteTimeoutMs: 1000 })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('protected-input-edge-owner'), {}, { cwd })
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
  if (first.done || first.value.type !== 'ready') throw new Error('Owner stream not ready')
  const clientId = first.value.clientId
  onTestFinished(async () => { controller.abort(); await events.return?.(); await peer.dispose() })
  const reply = async (eventId: string, value: ApprovalOutcome) => {
    const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://localhost/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: eventId, method: '$events/result', payload: { args: { clientId, eventId, outcome: { kind: 'result', value } } } }),
    }), peer)
    return response.json() as Promise<{ result: { ok: boolean } }>
  }
  return { ctx, agent, events, reply }
}

it('reloads approved protected inputs through the profile hook exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'approval-reload-edges-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const path = join(workspace, 'patch.yml')
  writeFileSync(path, 'trusted')
  const f = await fixture(workspace)
  const integrity = new ProtectedInputIntegrity(workspace, join(root, 'state'))
  integrity.observe(path)
  await integrity.grantWrite()
  writeFileSync(path, 'owner edit')
  const reload = vi.fn(async () => {})
  const profile: ProfileContext = {
    name: 'review-reload', cwd: workspace, dir: workspace, home: join(root, 'state'), patchPath: path, installAnchor: path,
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined, inputIntegrity: integrity,
    reloadProtectedInputs: reload, runInputReview: async (operation) => { await operation() },
  }
  f.ctx.provide('profileContext', profile)
  const frame = await f.events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected protected input review')
  expect(integrity.readTrusted(path)?.toString()).toBe('trusted')
  expect((await f.reply(frame.value.eventId, 'allowed-once')).result.ok).toBe(true)
  await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
  expect(integrity.readTrusted(path)?.toString()).toBe('owner edit')
})

it('skips integrity verification when the profile has no root agents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'approval-no-agents-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const f = await fixture(root)
  const integrity = new ProtectedInputIntegrity(root)
  const verify = vi.spyOn(integrity, 'verify')
  const roots = vi.spyOn(f.ctx.agents, 'roots').mockReturnValue([])
  const reviewed = Promise.withResolvers<undefined>()
  const profile: ProfileContext = {
    name: 'no-agents', cwd: root, dir: root, home: root, patchPath: join(root, 'patch.yml'), installAnchor: root,
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined, inputIntegrity: integrity,
    runInputReview: async (operation) => { await operation(); reviewed.resolve(undefined) },
  }
  f.ctx.provide('profileContext', profile)
  await reviewed.promise
  expect(roots).toHaveBeenCalled()
  expect(verify).not.toHaveBeenCalled()
})

it('audits a failed rule and rollback together without authorizing the workspace', async () => {
  const f = await fixture('/project')
  f.agent.session.append('turn/start', { turn: 1 })
  const commit = vi.fn(async () => {})
  const rollback = vi.fn(async () => { throw new Error('Rollback refused') })
  expect(await f.ctx.approval.request({ agent: f.agent, toolName: 'rule-edges', purpose: { type: 'workspace-write', workspace: '/project' } }, {
    check() { throw new Error('Rule inspection failed') }, commit, rollback,
  })).toBe('rejected')
  expect(commit).not.toHaveBeenCalled()
  expect(rollback).toHaveBeenCalledOnce()
  const audit = f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')
  expect(JSON.stringify(audit)).toContain('Rule inspection failed; rollback: Error: Rollback refused')
})

it('commits authenticated workspace consent when no launched profile needs capture', async () => {
  const f = await fixture('/project')
  f.agent.session.append('turn/start', { turn: 1 })
  expect(f.ctx.get('profileContext')).toBeUndefined()
  const commit = vi.fn(async () => {})
  const pending = f.ctx.approval.request({ agent: f.agent, toolName: 'absent-profile-edges', purpose: { type: 'workspace-write', workspace: '/project' } }, { check() {}, commit, rollback: async () => {} })
  const frame = await f.events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected workspace consent')
  expect((await f.reply(frame.value.eventId, 'allowed-once')).result.ok).toBe(true)
  expect(await pending).toBe('allowed-once')
  expect(commit).toHaveBeenCalledOnce()
})

it('cancels protected-input confirmation at the configured deadline', async () => {
  const f = await fixture('/project')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
  const pending = f.ctx.approval.requestProtectedInput(f.agent, { type: 'protected-input', path: '/project/patch.yml', previous: 'trusted', current: 'candidate' })
  const frame = await f.events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected protected input consent')
  await vi.advanceTimersByTimeAsync(1000)
  expect(await pending).toBe('cancelled')
})

it('refuses protected-input consent without a mounted owner gateway', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(ApprovalService, { workspaceWriteTimeoutMs: 1000 })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('no-gateway-edges'), {}, { cwd: '/project' })
  expect(await ctx.approval.requestProtectedInput(agent, { type: 'protected-input', path: '/project/patch.yml', previous: 'trusted', current: 'candidate' })).toBe('unavailable')
})
