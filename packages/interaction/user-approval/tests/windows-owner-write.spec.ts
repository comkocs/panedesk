/** Authenticated Windows consent reaches durable records and the native ACL hand-off. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import { workspaceWriteSid } from '@panedesk/dsh-sandbox-windows-acl'
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
import ApprovalService from '../src/index.ts'
import { FixtureAclWriteGrant, WindowsAclFixture, windowsAcl } from './windows-acl-fixture.ts'

vi.mock('@panedesk/dsh-sandbox-windows-acl', async original => ({
  ...await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>(),
  AclWriteGrant: (await import('./windows-acl-fixture.ts')).FixtureAclWriteGrant,
}))

async function fixture(protectedWorkspace = false) {
  const root = mkdtempSync(join(tmpdir(), 'windows-owner-write-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner-state')
  const profile = protectedWorkspace ? workspace : join(workspace, '.panedesk')
  mkdirSync(profile, { recursive: true })
  const input = join(profile, 'cordis.patch.yml')
  writeFileSync(input, 'before owner consent')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(ApprovalService, { workspaceWriteTimeoutMs: 1000 })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('windows-owner-write'), {}, { cwd: workspace })
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
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.stubEnv('PANEDESK_HOME', home)
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  windowsAcl.reset()
  onTestFinished(async () => {
    controller.abort()
    await events.return?.()
    await peer.dispose()
    await ctx.fiber.dispose()
    platform.mockRestore()
    vi.unstubAllEnvs()
    windowsAcl.reset()
    rmSync(root, { recursive: true, force: true })
  })
  ctx.provide('profileContext', {
    name: 'windows-owner-write', dir: profile, patchPath: input, installAnchor: join(profile, 'package.json'),
    home, cwd: workspace, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  await ctx.plugin(SandboxPolicyService, { workspaceRoot: workspace })
  await ctx.plugin(LocalSandboxProvider)
  const sandbox = ctx.sandbox
  if (!(sandbox instanceof LocalSandboxProvider)) throw new Error('Local sandbox provider missing')
  sandbox.internals = { platform: 'win32', windowsAclRunnerArgs: ['windows-acl-runner'] }
  const policy = ctx.sandboxPolicy
  const reader = new ProtectedInputIntegrity(workspace, home)
  const order: string[] = []
  windowsAcl.beforeAdd = (path) => {
    if (path !== workspace) return
    expect(policy.workspaceAccess.find(workspace)?.source).toBe('first-confirmation')
    order.push('record-before-acl')
  }
  agent.session.append('turn/start', { turn: 1 })
  const approve = async (outcome: 'allowed-once' | 'rejected') => {
    const pending = policy.requestWrite({ agent, toolName: 'windows-owner-write' })
    const settled = pending.then(value => ({ value }), (error: unknown) => ({ error }))
    const frame = await events.next()
    if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected workspace write approval')
    expect(frame.value.request.purpose).toEqual({ type: 'workspace-write', workspace })
    expect(policy.workspaceAccess.isAuthorized(workspace)).toBe(false)
    expect(windowsAcl.additions).toEqual([])
    expect(reader.covers(input)).toBe(false)
    writeFileSync(input, 'present when owner confirms')
    const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://localhost/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: frame.value.eventId, method: '$events/result',
        payload: { args: { clientId, eventId: frame.value.eventId, outcome: { kind: 'result', value: outcome } } } }),
    }), peer)
    expect(await response.json()).toMatchObject({ result: { ok: true } })
    return settled
  }
  return { workspace, profile, input, policy, sandbox, agent, approve, reader, order }
}

it('writes after authenticated owner consent, a durable record and one ACL materialization', async () => {
  const f = await fixture()
  const result = await f.approve('allowed-once')
  if ('error' in result) throw result.error
  expect(result.value.mode).toBe('workspace-write')
  expect(f.order).toEqual(['record-before-acl'])
  expect(f.reader.readTrusted(f.input)?.toString()).toBe('present when owner confirms')
  if (result.value.mode !== 'workspace-write') throw new Error('Expected approved workspace mode')
  const handed = await f.sandbox.confine(['node', 'write.js'], { ...result.value, mode: result.value.mode })
  expect(windowsAcl.additions.filter(path => path === f.workspace)).toHaveLength(1)
  const output = join(f.workspace, 'result.txt')
  windowsAcl.write(handed.argv, output, 'approved workspace write')
  expect(readFileSync(output, 'utf8')).toBe('approved workspace write')
  expect(() => { windowsAcl.write(handed.argv, f.input, 'forged configuration') }).toThrow('ACL access denied')
  const sid = workspaceWriteSid(f.workspace)
  expect(windowsAcl.permits(f.profile, sid, 'write')).toBe(false)
  expect(windowsAcl.permits(f.profile, sid, 'delete')).toBe(false)
  expect(windowsAcl.permits(f.input, sid, 'delete')).toBe(false)
  await f.policy.workspaceAccess.revoke(f.workspace, (path) => { f.sandbox.revokeWorkspaceWriteGrant(path) })
  const revoked = f.policy.resolve({ session: f.agent.session })
  expect(revoked.mode).toBe('read-only')
  if (revoked.mode !== 'read-only') throw new Error('Expected revoked read-only mode')
  const readonly = await f.sandbox.confine(['node', 'write.js'], { ...revoked, mode: revoked.mode })
  expect(() => { windowsAcl.write(readonly.argv, output, 'after revocation') }).toThrow('ACL access denied')
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
})

it('keeps an entirely protected workspace non-writable even after authenticated owner consent', async () => {
  const f = await fixture(true)
  const result = await f.approve('allowed-once')
  if (!('error' in result) || !(result.error instanceof Error)) throw new Error('Expected protected workspace refusal')
  expect(result.error.message).toContain('protected host path')
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
})

it('keeps a rejected Windows owner decision read-only without a record or ACL', async () => {
  const f = await fixture()
  const result = await f.approve('rejected')
  expect('error' in result).toBe(true)
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
  expect(f.reader.covers(f.input)).toBe(false)
})

it('orders explicit deny before explicit allow and inherited allow for the same SID', () => {
  const acl = new WindowsAclFixture()
  const root = join(tmpdir(), 'acl-order')
  const path = join(root, 'protected')
  const sid = 'workspace-capability'
  acl.entries.push(
    { path: root, sid, deny: false, recursive: true, rights: ['write'] },
    { path, sid, deny: false, recursive: true, rights: ['write'] },
    { path, sid, deny: true, recursive: true, rights: ['write'] },
  )
  expect(acl.permits(path, sid, 'write')).toBe(false)
  expect(acl.permits(join(path, 'child'), sid, 'write')).toBe(false)
  acl.entries.splice(1, 1)
  expect(acl.permits(path, sid, 'write')).toBe(false)
  acl.entries.push({ path: join(path, 'child'), sid, deny: false, recursive: false, rights: ['write'] })
  expect(acl.permits(join(path, 'child'), sid, 'write')).toBe(true)
  expect(acl.permits(path, 'other-capability', 'write')).toBe(false)
  const grant = new FixtureAclWriteGrant(sid)
  expect(grant.has(path)).toBe(false)
})
