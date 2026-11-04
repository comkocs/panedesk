/** Protected-input decisions use authenticated owner transport even between turns. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import SandboxPolicyService from '../../../sandbox/sandbox-policy/src/index.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ClientModuleRegistry } from '../../../client/modules/src/index.ts'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'
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

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

vi.mock('@panedesk/dsh-sandbox-windows-acl', async (original) => {
  const actual = await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>()
  return { ...actual, assertWindowsStateTrusted: vi.fn() }
})

const purpose = { type: 'protected-input', path: '/project/profile/patch.yml', previous: 'old-digest', current: 'new-digest' } as const

async function fixture(cwd = '/project') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(ApprovalService, { workspaceWriteTimeoutMs: 1000 })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('protected-input-owner'), {}, { cwd })
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

it.each(['allowed-once', 'rejected'] as const)('captures Windows inputs after authenticated consent and before write authorization: %s', async (outcome) => {
  const root = mkdtempSync(join(tmpdir(), 'owner-write-capture-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner-state')
  const profile = join(workspace, '.panedesk')
  mkdirSync(profile, { recursive: true })
  const f = await fixture(workspace)
  const path = join(profile, 'cordis.patch.yml')
  writeFileSync(path, 'before owner consent')
  const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.stubEnv('PANEDESK_HOME', home)
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  onTestFinished(() => {
    platformSpy.mockRestore()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  f.ctx.provide('profileContext', {
    name: 'windows-capture', dir: profile, patchPath: path, installAnchor: join(profile, 'package.json'),
    home, cwd: workspace, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  await f.ctx.plugin(SandboxPolicyService, { workspaceRoot: workspace })
  const policy = f.ctx.sandboxPolicy
  expect(policy.resolve({ session: f.agent.session }).workspaceRoot).toBe(workspace)
  f.agent.session.append('turn/start', { turn: 1 })
  const reader = new ProtectedInputIntegrity(workspace, home)
  expect(reader.covers(path)).toBe(false)
  const pending = policy.requestWrite({ agent: f.agent, toolName: 'capture-fixture' })
  const settled = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  const frame = await f.events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected workspace write approval')
  expect(reader.covers(path)).toBe(false)
  writeFileSync(path, 'present when owner confirms')
  expect((await f.reply(frame.value.eventId, outcome)).result.ok).toBe(true)
  const result = await settled
  if (outcome === 'allowed-once') {
    if ('error' in result) throw result.error
    expect(result.value.mode).toBe('workspace-write')
    expect(reader.covers(path)).toBe(true)
    writeFileSync(path, 'after authorization')
    expect(reader.readTrusted(path)?.toString()).toBe('present when owner confirms')
  } else {
    expect('error' in result).toBe(true)
    expect(reader.covers(path)).toBe(false)
    expect(policy.workspaceAccess.isAuthorized(workspace)).toBe(false)
  }
})

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

it.each(['allowed-once', 'rejected'] as const)('reviews offline inputs after owner transport readiness without HMR: %s', async (outcome) => {
  const f = await fixture()
  const root = mkdtempSync(join(tmpdir(), 'owner-input-review-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const path = join(workspace, 'patch.yml')
  writeFileSync(path, 'trusted')
  const integrity = new ProtectedInputIntegrity(workspace, join(root, 'state'))
  integrity.observe(path)
  await integrity.grantWrite()
  writeFileSync(path, 'offline edit')
  const notice = vi.spyOn(f.agent, 'inject')
  f.ctx.provide('profileContext', {
    name: 'review', cwd: workspace, dir: workspace, home: join(root, 'state'),
    patchPath: path, installAnchor: workspace, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    inputIntegrity: integrity,
  })
  const frame = await f.events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected startup input review')
  expect(frame.value.request.purpose).toMatchObject({ type: 'protected-input', path })
  expect((await f.reply(frame.value.eventId, outcome)).result.ok).toBe(true)
  await vi.waitFor(() => {
    if (outcome === 'allowed-once') expect(integrity.readTrusted(path)?.toString()).toBe('offline edit')
    else expect(notice.mock.calls.some(([message]) => JSON.stringify(message).includes('rejected'))).toBe(true)
  })
  if (outcome === 'rejected') expect(integrity.readTrusted(path)?.toString()).toBe('trusted')
  expect(f.agent.status).toBe('idle')
})

it.each([
  ['new chunk', 'allowed-once'], ['new chunk', 'rejected'],
  ['package replacement', 'allowed-once'], ['package replacement', 'rejected'],
] as const)('keeps Client artifacts behind authenticated owner decisions: %s / %s', async (change, outcome) => {
  const f = await fixture()
  const root = mkdtempSync(join(tmpdir(), 'owner-client-input-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'node_modules', '@fixture', 'protected-client')
  const home = join(root, 'state')
  const entry = join(workspace, 'lib', 'client.js')
  const chunk = join(workspace, 'lib', 'client.extra.js')
  const writePackage = (generation: string): void => {
    mkdirSync(join(workspace, 'lib'), { recursive: true })
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      name: '@fixture/protected-client', exports: { './client': './lib/client.js', './package.json': './package.json' },
      dsh: { client: { platform: 'web' } },
    }))
    writeFileSync(entry, `module.exports = { generation: "${generation}" }\n`)
  }
  writePackage('trusted')
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(workspace)
  await integrity.grantWrite()
  const client = new Context()
  onTestFinished(() => client.fiber.dispose())
  client.baseUrl = pathToFileURL(root).href + '/'
  client.provide('loader', {
    *entries() {
      yield { options: { name: '@fixture/protected-client' }, fiber: {}, disabled: false,
        parent: { tree: { ctx: { baseUrl: client.baseUrl } } } }
    },
  })
  client.provide('profileContext', {
    name: 'client-review', cwd: workspace, dir: workspace, home, patchPath: entry,
    installAnchor: join(workspace, 'package.json'), startedBundles: [], overlays: [],
    telemetryDisabledEnv: undefined, inputIntegrity: integrity,
  })
  const service = new ClientModuleRegistry(client)
  const before = service.graph()
  const row = before.entries[0]
  if (row === undefined) throw new Error('Protected Client row missing')
  const request = (url: string) => service.fetchBundle(new Request(`http://localhost/${url}`))
  const chunkUrl = `plugins/${row.id}/client.extra.js?rev=${row.rev}`
  if (change === 'package replacement') {
    rmSync(workspace, { recursive: true })
    writePackage('replacement')
  }
  writeFileSync(chunk, 'module.exports = { candidate: true }\n')
  await expect(request(chunkUrl)).rejects.toThrow('requires owner confirmation')
  expect(() => service.rebuilt(row.id)).toThrow('requires owner confirmation')
  expect(service.graph()).toBe(before)
  expect(await (await request(row.url)).text()).toContain('trusted')
  const verify = integrity.verify({
    blocked() {},
    confirm: async candidate => await f.ctx.approval.requestProtectedInput(f.agent, {
      type: 'protected-input', ...candidate,
    }) === 'allowed-once',
  })
  const frame = await f.events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected Client artifact approval')
  expect(frame.value.request.purpose).toMatchObject({ type: 'protected-input', path: workspace })
  expect((await f.reply(frame.value.eventId, outcome)).result.ok).toBe(true)
  expect(await verify).toBe(outcome === 'allowed-once')
  if (outcome === 'allowed-once') {
    service.rebuilt(row.id)
    const approved = service.graph().entries[0]
    if (approved === undefined) throw new Error('Approved Client row missing')
    expect(await (await request(`plugins/${row.id}/client.extra.js?rev=${approved.rev}`)).text()).toContain('candidate: true')
    expect(await (await request(approved.url)).text()).toContain(change === 'package replacement' ? 'replacement' : 'trusted')
  } else {
    await expect(request(chunkUrl)).rejects.toThrow('requires owner confirmation')
    expect(service.graph()).toBe(before)
    expect(await (await request(row.url)).text()).toContain('trusted')
    expect(new ProtectedInputIntegrity(workspace, home).readTrusted(entry)?.toString()).toContain('trusted')
  }
  expect(f.agent.status).toBe('idle')
  expect(f.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
})

it('retains offline input refusal notices without HMR in an unattended profile', async () => {
  const f = await fixture()
  setApprovalPolicy(f.agent.session, 'never')
  const root = mkdtempSync(join(tmpdir(), 'unattended-input-review-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'patch.yml')
  writeFileSync(path, 'trusted')
  const integrity = new ProtectedInputIntegrity(root)
  integrity.observe(path)
  writeFileSync(path, 'offline edit')
  const transport = vi.spyOn(f.ctx.typertGateway, 'requestOwnerEvent')
  const notice = vi.spyOn(f.agent, 'inject')
  f.ctx.provide('profileContext', {
    name: 'unattended', cwd: root, dir: root, home: root, patchPath: path,
    installAnchor: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined, inputIntegrity: integrity,
  })
  await vi.waitFor(() => { expect(notice).toHaveBeenCalled() })
  expect(transport).not.toHaveBeenCalled()
  expect(integrity.readTrusted(path)?.toString()).toBe('trusted')
  expect(f.agent.status).toBe('idle')
})

it.each([true, false])('waits for protected input review before admitting a new agent: %s', async (allowed) => {
  const f = await fixture()
  const integrity = new ProtectedInputIntegrity('/project')
  const baseline = vi.spyOn(integrity, 'verify').mockResolvedValue(true)
  f.ctx.provide('profileContext', {
    name: 'admission', cwd: '/project', dir: '/project', home: '/owner', patchPath: '/project/patch.yml',
    installAnchor: '/project/package.json', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    inputIntegrity: integrity,
  })
  await vi.waitFor(() => { expect(baseline).toHaveBeenCalled() })
  const reviewing = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<boolean>()
  baseline.mockImplementation(async () => { reviewing.resolve(undefined); return release.promise })
  let settled = false
  const pending = f.ctx.agents.create({ sessionId: SessionId(`review-admission-${allowed}`), meta: { cwd: '/project' } })
  const outcome = pending.then((handle) => { settled = true; return { handle } }, (error: unknown) => { settled = true; return { error } })
  await reviewing.promise
  await Promise.resolve()
  try { expect(settled).toBe(false) } finally { release.resolve(allowed) }
  const result = await outcome
  if (allowed) expect('handle' in result).toBe(true)
  else {
    expect('error' in result).toBe(true)
    expect(f.ctx.agents.get(SessionId(`review-admission-${allowed}`))).toBeUndefined()
  }
})

it('retains bilingual capture recovery instructions in consent audit and new-agent denial', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-capture-failure-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'state')
  mkdirSync(workspace)
  const path = join(workspace, 'patch.yml')
  writeFileSync(path, 'trusted')
  const f = await fixture(workspace)
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(path)
  const original = fs.openSync
  const read = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === path && args[1] === 'r') throw new Error('capture interrupted')
    return original(...args)
  })
  onTestFinished(() => { read.mockRestore(); rmSync(root, { recursive: true, force: true }) })
  f.ctx.provide('profileContext', {
    name: 'failed-capture', cwd: workspace, dir: workspace, home, patchPath: path,
    installAnchor: path, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    inputIntegrity: integrity,
  })
  f.agent.session.append('turn/start', { turn: 1 })
  const commit = vi.fn(async () => {})
  const rollback = vi.fn(async () => {})
  const pending = f.ctx.approval.request({ agent: f.agent, toolName: 'capture-fixture',
    purpose: { type: 'workspace-write', workspace } }, { check() {}, commit, rollback })
  const frame = await f.events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected workspace write approval')
  expect((await f.reply(frame.value.eventId, 'allowed-once')).result.ok).toBe(true)
  expect(await pending).toBe('rejected')
  expect(commit).not.toHaveBeenCalled()
  expect(rollback).toHaveBeenCalledOnce()
  const audit = f.agent.session.snapshotEvents().find(event => event.type === 'approval/decided')
  const english = 'Explicitly authorize workspace write access again to capture a new baseline.'
  const chinese = '请重新显式授权该工作区写入一次，以重新捕获基线。'
  expect(JSON.stringify(audit)).toContain(english)
  expect(JSON.stringify(audit)).toContain(chinese)
  for (const [index, message] of [english, chinese].entries()) {
    const sessionId = SessionId(`failed-capture-${index}`)
    await expect(f.ctx.agents.create({ sessionId, meta: { cwd: workspace } })).rejects.toThrow(message)
    expect(f.ctx.agents.get(sessionId)).toBeUndefined()
  }
  read.mockRestore()
  await integrity.grantWrite()
  const recovered = SessionId('capture-recovered')
  await f.ctx.agents.create({ sessionId: recovered, meta: { cwd: workspace } })
  expect(f.ctx.agents.get(recovered)).toBeDefined()
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
