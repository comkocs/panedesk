/** Authenticated Windows consent reaches durable records and the native ACL hand-off. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import { UnsafeWindowsStateError, workspaceWriteSid } from '@panedesk/dsh-sandbox-windows-acl'
import { inspectStateAncestors } from '../../../sandbox/sandbox-windows-acl/src/state-access.ts'
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
  assertWindowsStateTrusted: checkFixtureState,
}))

function checkFixtureState(directory: string, workspace: string): void {
  const unsafe = inspectStateAncestors(directory, {
    permits: (path, mask) => windowsAcl.permitsToken(path, [workspaceWriteSid(workspace)], mask),
  })
  if (unsafe !== undefined) throw new UnsafeWindowsStateError(unsafe.path, unsafe.mask)
}

async function fixture(protectedWorkspace = false, nestedState = false) {
  const root = mkdtempSync(join(tmpdir(), 'windows-owner-write-'))
  const workspace = join(root, 'workspace')
  const home = join(nestedState ? workspace : root, 'owner-state')
  const profile = protectedWorkspace ? workspace : join(workspace, '.panedesk')
  mkdirSync(profile, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'cordis.patch.yml'), '[]\n')
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
  return { ctx, harness, workspace, home, profile, input, policy, sandbox, agent, approve, reader, order }
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
  const createdDirectory = join(f.workspace, 'created-after-consent')
  const sid = workspaceWriteSid(f.workspace)
  expect(windowsAcl.permits(createdDirectory, sid, 'write')).toBe(true)
  mkdirSync(createdDirectory)
  const createdFile = join(createdDirectory, 'nested.txt')
  windowsAcl.write(handed.argv, createdFile, 'new directory remains writable')
  expect(readFileSync(createdFile, 'utf8')).toBe('new directory remains writable')
  const authorization = f.policy.workspaceAccess.recordPath(f.workspace)
  const trustedDirectory = join(authorization, '..', 'protected-inputs')
  expect(result.value.protectedPaths).toContain(join(authorization, '..'))
  expect(() => { windowsAcl.write(handed.argv, authorization, 'forged consent') }).toThrow('ACL access denied')
  expect(windowsAcl.permits(trustedDirectory, sid, 'write')).toBe(false)
  expect(windowsAcl.permits(trustedDirectory, sid, 'delete')).toBe(false)
  expect(() => { windowsAcl.write(handed.argv, f.input, 'forged configuration') }).toThrow('ACL access denied')
  expect(windowsAcl.permits(f.profile, sid, 'write')).toBe(false)
  expect(windowsAcl.permits(f.profile, sid, 'delete')).toBe(false)
  expect(windowsAcl.permits(f.input, sid, 'delete')).toBe(false)
  await f.policy.workspaceAccess.revoke(f.workspace, (path) => { f.sandbox.revokeWorkspaceWriteGrant(path) })
  expect(windowsAcl.entries.filter(entry => entry.sid === sid)).toEqual([])
  const revoked = f.policy.resolve({ session: f.agent.session })
  expect(revoked.mode).toBe('read-only')
  if (revoked.mode !== 'read-only') throw new Error('Expected revoked read-only mode')
  const readonly = await f.sandbox.confine(['node', 'write.js'], { ...revoked, mode: revoked.mode })
  expect(() => { windowsAcl.write(readonly.argv, output, 'after revocation') }).toThrow('ACL access denied')
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
})

it('revokes every explicit workspace capability after restart and checks every former grant point', async () => {
  const f = await fixture()
  const result = await f.approve('allowed-once')
  if ('error' in result) throw result.error
  const child = join(f.workspace, 'explicit-child')
  mkdirSync(child)
  const sid = workspaceWriteSid(f.workspace)
  new FixtureAclWriteGrant(sid).add(child)
  const restarted = new Context()
  onTestFinished(async () => { await restarted.fiber.dispose() })
  await restarted.plugin(LocalSandboxProvider)
  const sandbox = restarted.sandbox
  if (!(sandbox instanceof LocalSandboxProvider)) throw new Error('Local sandbox provider missing')
  sandbox.internals = { platform: 'win32', windowsAclRunnerArgs: ['windows-acl-runner'] }
  await f.policy.workspaceAccess.revoke(f.workspace, (path) => { sandbox.revokeWorkspaceWriteGrant(path) })
  for (const path of [f.workspace, child, f.profile]) {
    expect(windowsAcl.permits(path, sid, 'write'), path).toBe(false)
    expect(windowsAcl.permits(path, sid, 'delete'), path).toBe(false)
  }
  expect(windowsAcl.entries.filter(entry => entry.sid === sid)).toEqual([])
})

it('rejects a protected profile before requesting authenticated owner consent', async () => {
  const f = await fixture(true)
  const dispatch = vi.spyOn(f.ctx.typertGateway, 'requestOwnerEvent')
  await expect(f.policy.requestWrite({ agent: f.agent, toolName: 'windows-owner-write' })).rejects.toThrow()
  expect(dispatch.mock.calls.length).toBe(0)
  const decision = f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')
  expect(decision?.data.outcome).toBe('rejected')
  expect(decision?.data.reason).toContain('This directory is a protected profile directory; choose another workspace')
  expect(decision?.data.reason).toContain('该目录是受保护的 profile 目录，请换一个工作区')
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
})

it('rejects nested state before asking an owner and retains the refusal in the durable inbox', async () => {
  const f = await fixture(false, true)
  const policy = f.policy.resolve({ session: f.agent.session })
  expect(policy.mode).toBe('read-only')
  if (policy.mode !== 'read-only') throw new Error('Expected initial read-only mode')
  const handed = await f.sandbox.confine(['node', 'read.js'], { ...policy, mode: policy.mode })
  expect(handed.argv).toContain('read-only')
  expect(windowsAcl.additions).toEqual([])
  const dispatch = vi.spyOn(f.ctx.typertGateway, 'requestOwnerEvent')
  await expect(f.policy.requestWrite({ agent: f.agent, toolName: 'windows-owner-write' })).rejects.toThrow()
  expect(dispatch.mock.calls.length).toBe(0)
  const reason = 'The workspace contains the Panedesk state directory; choose one of its subdirectories. / 工作区包含 Panedesk 状态目录，请选它的子目录。'
  expect(JSON.stringify(f.agent.inbox.nextStep)).toContain(reason)
  expect(JSON.stringify(f.agent.session.snapshotEvents())).toContain(reason)
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome))
    .toEqual(['rejected'])
  expect(f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')?.data.reason)
    .toContain(reason)
  expect(f.policy.resolve({ session: f.agent.session }).mode).toBe('read-only')
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
})

it('rejects unsafe state ancestors before asking an owner and records the bilingual reason', async () => {
  const f = await fixture()
  windowsAcl.entries.push({ path: f.home, sid: 'S-1-1-0', deny: false, recursive: false, rights: ['write-dac'] })
  const dispatch = vi.spyOn(f.ctx.typertGateway, 'requestOwnerEvent')
  await expect(f.policy.requestWrite({ agent: f.agent, toolName: 'windows-owner-write' })).rejects.toThrow()
  expect(dispatch.mock.calls.length).toBe(0)
  const decision = f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')
  expect(decision?.data.outcome).toBe('rejected')
  expect(decision?.data.reason).toContain('Windows owner state is not trusted')
  expect(decision?.data.reason).toContain('Windows 所有者状态不可信')
  expect(JSON.stringify(f.agent.inbox.nextStep)).toContain('Windows 所有者状态不可信')
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
})

it('rejects a failed rule check before owner dispatch and retains its sanitized diagnostic', async () => {
  const f = await fixture()
  const dispatch = vi.spyOn(f.ctx.typertGateway, 'requestOwnerEvent')
  vi.spyOn(f.policy.workspaceAccess, 'assertCanAuthorize').mockImplementation(() => {
    throw new Error('state probe unavailable')
  })
  await expect(f.policy.requestWrite({ agent: f.agent, toolName: 'windows-owner-write' })).rejects.toThrow('rejected')
  expect(dispatch).not.toHaveBeenCalled()
  const reason = 'Rule check failed: Error: state probe unavailable / 规则检查失败:Error: state probe unavailable'
  expect(f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')?.data)
    .toMatchObject({ outcome: 'rejected', reason })
  expect(JSON.stringify(f.agent.inbox.nextStep)).toContain(reason)
  expect(f.policy.resolve({ session: f.agent.session }).mode).toBe('read-only')
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
})

it('rechecks rules after owner consent before recording consent or materializing ACLs', async () => {
  const f = await fixture()
  const dispatch = f.ctx.typertGateway.requestOwnerEvent.bind(f.ctx.typertGateway)
  vi.spyOn(f.ctx.typertGateway, 'requestOwnerEvent').mockImplementation(async (...args) => {
    const outcome = await dispatch(...args)
    windowsAcl.entries.push({ path: f.home, sid: 'S-1-1-0', deny: false, recursive: false, rights: ['write-dac'] })
    return outcome
  })
  const result = await f.approve('allowed-once')
  expect('error' in result).toBe(true)
  const decision = f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')
  expect(decision?.data.outcome).toBe('rejected')
  expect(decision?.data.reason).toContain('Windows owner state is not trusted')
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
})

it('records a genuine owner transport absence as unavailable without granting writes', async () => {
  const f = await fixture()
  vi.spyOn(f.ctx.typertGateway, 'requestOwnerEvent').mockResolvedValue({ kind: 'next' })
  await expect(f.policy.requestWrite({ agent: f.agent, toolName: 'windows-owner-write' })).rejects.toThrow('unavailable')
  expect(f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')?.data)
    .toMatchObject({ outcome: 'unavailable' })
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
})

it('records owner transport exceptions as unavailable with their class and text', async () => {
  const f = await fixture()
  const inject = vi.spyOn(f.agent, 'inject')
  vi.spyOn(f.ctx.typertGateway, 'requestOwnerEvent').mockRejectedValue(new TypeError('owner result decoding failed'))
  await expect(f.policy.requestWrite({ agent: f.agent, toolName: 'windows-owner-write' })).rejects.toThrow()
  expect(f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')?.data)
    .toMatchObject({ outcome: 'unavailable', reason: 'TypeError: owner result decoding failed' })
  expect(inject).not.toHaveBeenCalled()
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
})

it('rejects a materialization failure and removes its committed authorization', async () => {
  const f = await fixture()
  const inject = vi.spyOn(f.agent, 'inject')
  vi.spyOn(f.sandbox, 'materializeWorkspaceWriteGrant').mockRejectedValue(new Error('ACL materialization failed'))
  const result = await f.approve('allowed-once')
  expect('error' in result).toBe(true)
  expect(f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')?.data)
    .toMatchObject({ outcome: 'rejected',
      reason: 'Approved but authorization failed: Error: ACL materialization failed / 已批准但授权失败:Error: ACL materialization failed' })
  expect(inject).not.toHaveBeenCalled()
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(f.policy.resolve({ session: f.agent.session }).mode).toBe('read-only')
  expect(windowsAcl.additions).toEqual([])
})

it('revokes materialized access when the decision audit cannot commit', async () => {
  const f = await fixture()
  const materialize = f.sandbox.materializeWorkspaceWriteGrant.bind(f.sandbox)
  vi.spyOn(f.sandbox, 'materializeWorkspaceWriteGrant').mockImplementation(async (...args) => {
    await materialize(...args)
    vi.spyOn(f.agent.session, 'append').mockImplementationOnce(() => { throw new Error('decision append failed') })
  })
  const result = await f.approve('allowed-once')
  expect('error' in result).toBe(true)
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(f.policy.resolve({ session: f.agent.session }).mode).toBe('read-only')
  expect(windowsAcl.entries.filter(entry => entry.sid === workspaceWriteSid(f.workspace))).toEqual([])
})

it('keeps a rejected Windows owner decision read-only without a record or ACL', async () => {
  const f = await fixture()
  const inject = vi.spyOn(f.agent, 'inject')
  const result = await f.approve('rejected')
  expect(inject).not.toHaveBeenCalled()
  expect('error' in result).toBe(true)
  expect(f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')?.data)
    .toMatchObject({ outcome: 'rejected', reason: 'Owner rejected / owner 拒' })
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  expect(windowsAcl.additions).toEqual([])
  expect(f.reader.covers(f.input)).toBe(false)
})

it('warns when opening an unrecorded writable workspace and revokes its exact SID across the tree', async () => {
  const f = await fixture()
  const sid = workspaceWriteSid(f.workspace)
  windowsAcl.entries.push({ path: f.workspace, sid, deny: false, recursive: false, rights: ['write'] })
  expect(f.policy.workspaceAccess.find(f.workspace)).toBeUndefined()
  const legacy = await f.harness.create(SessionId('legacy-workspace'), {}, { cwd: f.workspace })
  const notice = JSON.stringify(legacy.inbox.nextStep)
  expect(notice).toContain('This workspace has write access left by an older version.')
  expect(notice).toContain('该工作区有旧版留下的写权限。')
  expect(notice).toContain('Settings > General > Windows workspace write access')
  expect(f.sandbox.hasWorkspaceWriteGrant(f.workspace)).toBe(true)
  await f.policy.workspaceAccess.revoke(f.workspace, (path) => { f.sandbox.revokeWorkspaceWriteGrant(path) })
  expect(windowsAcl.permitsToken(f.workspace, [sid], 2)).toBe(false)
  expect(f.sandbox.hasWorkspaceWriteGrant(f.workspace)).toBe(false)
})

it('retains a visible inspection failure without blocking read-only workspace opening', async () => {
  const f = await fixture()
  vi.spyOn(f.sandbox, 'hasWorkspaceWriteGrant').mockImplementation(() => { throw new Error('AccessCheck unavailable') })
  const opened = await f.harness.create(SessionId('inspection-failed'), {}, { cwd: f.workspace })
  const notice = JSON.stringify(opened.inbox.nextStep)
  expect(notice).toContain('AccessCheck unavailable')
  expect(notice).toContain('Could not inspect existing workspace write access')
  expect(notice).toContain('无法检查已有工作区写权限')
  expect(notice).not.toContain('This workspace has write access left by an older version.')
  expect(f.policy.resolve({ session: opened.session }).mode).toBe('read-only')
  expect(windowsAcl.additions).toEqual([])
})

it('does not warn about legacy access for a normally recorded workspace', async () => {
  const f = await fixture()
  const result = await f.approve('allowed-once')
  if ('error' in result) throw result.error
  const recorded = await f.harness.create(SessionId('recorded-workspace'), {}, { cwd: f.workspace })
  expect(JSON.stringify(recorded.inbox.nextStep)).not.toContain('write access left by an older version')
  expect(JSON.stringify(recorded.inbox.nextStep)).not.toContain('旧版留下的写权限')
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
