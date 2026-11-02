/** Profile watches share HMR's queue and readiness barrier without waiting for package installation. */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Timer from '@panedesk/cordis-plugin-timer'
import { boot, initProfile, ProtectedInputIntegrity, readProfileManifest, readProfilePatches, type ProfileContext } from '@panedesk/dsh-app-boot'
import { withFileLock } from '@panedesk/dsh-atomic-write'
import { FSWatcher } from 'chokidar'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '../../../test-support/agent-loop-testkit/src/index.ts'
import ApprovalService, { setApprovalPolicy } from '../../../interaction/user-approval/src/index.ts'
import Gateway from '../../../api/gateway/src/index.ts'
import TypertRegistry from '../../../typert/registry/src/index.ts'
import RemoteAccess from '../../../api/remote-access/src/index.ts'
import * as Remotes from '../../../api/remotes/src/index.ts'
import { Peer, apply as applyConnection, inject as connectionInject } from '../../../client/connection/src/index.ts'
import { provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import type { RemoteEventDownlinkFrame } from '../../../api/gateway/src/stream-protocol.ts'
import Hmr from '../src/index.ts'

const watchers = vi.hoisted(() => [] as FSWatcher[])
vi.mock('chokidar', async (original) => {
  const native = await original<typeof import('chokidar')>()
  return { ...native, watch: () => {
    const watcher = new native.FSWatcher()
    watchers.push(watcher)
    queueMicrotask(() => watcher.emit('ready'))
    return watcher
  } }
})

async function fixture(beforeWatch?: (profile: ProfileContext) => void, protectedWorkspace = false, launchWorkspace?: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hmr-profile-')))
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, [])
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: launchWorkspace ?? home,
    ...(protectedWorkspace ? { inputIntegrity: new ProtectedInputIntegrity(home) } : {}),
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  const rows = [{ insert: [
    { id: 'timer', name: 'cordis:timer' },
    { id: 'hmr', name: 'cordis:hmr', config: { root: [] } },
    { id: 'probe', name: 'cordis:probe', config: { value: 'initial' } },
  ] }]
  writeFileSync(profile.patchPath, JSON.stringify(rows))
  let commit: (() => void) | undefined
  const start = watchers.length
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (host) => {
    beforeWatch?.(profile)
    host.provide('profileContext', profile)
    host.provide('appReady', { onReady(listener) { commit = listener; return () => { commit = undefined } } })
    host.loader.builtins.timer = Timer
    host.loader.builtins.hmr = Hmr
    host.loader.builtins.probe = { apply(ctx: Context, config: { value: string }) { ctx.provide('profileProbe', config.value) } }
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const configWatches = watchers.slice(start, start + 3)
  const emit = (index: number, filename: string) => { configWatches[index]!.emit('change', filename) }
  const drain = () => ctx.hmr.runExclusive(async () => {})
  return { ctx, profile, dir, home, emit, drain, commit: () => commit?.() }
}

it('waits for application readiness and applies profile, home and manifest changes', async () => {
  const f = await fixture()
  const patches = [{ insert: [
    { id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } },
    { id: 'probe', name: 'cordis:probe', config: { value: 'edited' } },
  ] }]
  writeFileSync(f.profile.patchPath, JSON.stringify(patches))
  f.emit(0, f.profile.patchPath)
  let completed = false
  const drained = f.drain().then(() => { completed = true })
  await Promise.resolve(undefined)
  expect(completed).toBe(false)
  expect(f.ctx.get('profileProbe')).toBe('initial')
  f.commit()
  await drained
  expect(f.ctx.get('profileProbe')).toBe('edited')
  const homePatch = join(f.home, 'cordis.patch.yml')
  writeFileSync(homePatch, '- id: probe\n  config: { value: home }\n')
  f.emit(1, homePatch)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('home')
  rmSync(homePatch)
  const manifest = join(f.dir, 'package.json')
  f.emit(1, homePatch)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('edited')
  f.emit(2, manifest)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('edited')
})

it('rejects a replaced profile parent until the owner confirms the new input', async () => {
  const f = await fixture(undefined, true)
  f.commit()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const moved = `${f.dir}-previous`
  renameSync(f.dir, moved)
  cpSync(moved, f.dir, { recursive: true })
  const original = readFileSync(f.profile.patchPath, 'utf8')
  writeFileSync(f.profile.patchPath, original.replace('initial', 'unapproved-replacement'))
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('initial')
  expect(warn).toHaveBeenCalled()
})

it.each(['delete-recreate', 'symlink-replace'] as const)('rejects %s of the profile parent with an owner notice', async (method) => {
  const f = await fixture(undefined, true)
  f.commit()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const moved = `${f.dir}-previous`
  cpSync(f.dir, moved, { recursive: true })
  rmSync(f.dir, { recursive: true })
  if (method === 'symlink-replace') symlinkSync(moved, f.dir, process.platform === 'win32' ? 'junction' : 'dir')
  else cpSync(moved, f.dir, { recursive: true })
  const original = readFileSync(f.profile.patchPath, 'utf8')
  writeFileSync(f.profile.patchPath, original.replace('initial', 'unapproved-replacement'))
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('initial')
  expect(warn).toHaveBeenCalled()
})

it.each(['direct-write', 'create-missing'] as const)('rejects %s of a protected patch with an owner notice', async (method) => {
  const f = await fixture(undefined, true)
  f.commit()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const path = method === 'create-missing' ? join(f.home, 'cordis.patch.yml') : f.profile.patchPath
  if (method === 'create-missing') writeFileSync(path, '- id: probe\n  config: { value: unapproved-replacement }\n')
  else writeFileSync(path, readFileSync(path, 'utf8').replace('initial', 'unapproved-replacement'))
  f.emit(method === 'create-missing' ? 1 : 0, path)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('initial')
  expect(warn).toHaveBeenCalled()
})

it.each(['allowed-once', 'rejected'] as const)('applies an owner edit only after the authenticated decision: %s', async (outcome) => {
  const f = await fixture(undefined, true)
  await mountAgentLoopTestDependencies(f.ctx)
  provideWorkingDirectoryFixture(f.ctx)
  await f.ctx.plugin(ApprovalService, { workspaceWriteTimeoutMs: 1000 })
  const harness = await mountAgentLoopTestHarness(f.ctx)
  const agent = await harness.create(SessionId('profile-owner'), {}, { cwd: f.home })
  provideBrowserCredentials(f.ctx)
  await f.ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  await f.ctx.plugin(TypertRegistry)
  await f.ctx.plugin(RemoteAccess)
  await f.ctx.plugin(Gateway)
  await f.ctx.plugin(Remotes)
  const peer = new Peer(f.ctx, { principal: { kind: 'owner' } })
  const controller = new AbortController()
  const stream = await f.ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, controller.signal)
  const events = stream[Symbol.asyncIterator]() as AsyncIterator<RemoteEventDownlinkFrame>
  const ready = await events.next()
  if (ready.done || ready.value.type !== 'ready') throw new Error('Owner stream did not become ready')
  const clientId = ready.value.clientId
  onTestFinished(async () => { controller.abort(); await events.return?.(); await peer.dispose() })
  f.commit()
  writeFileSync(f.profile.patchPath, readFileSync(f.profile.patchPath, 'utf8').replace('initial', 'owner-edit'))
  f.emit(0, f.profile.patchPath)
  const frame = await events.next()
  if (frame.done || frame.value.type !== 'waterfall') throw new Error('Expected protected-input approval')
  expect(frame.value.request.purpose).toMatchObject({ type: 'protected-input', path: f.profile.patchPath })
  expect(f.ctx.get('profileProbe')).toBe('initial')
  const response = await f.ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://localhost/api/$events/result', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: frame.value.eventId, method: '$events/result',
      payload: { args: { clientId, eventId: frame.value.eventId, outcome: { kind: 'result', value: outcome } } } }),
  }), peer)
  expect(await response.json()).toMatchObject({ result: { ok: true } })
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe(outcome === 'allowed-once' ? 'owner-edit' : 'initial')
  expect(agent.status).toBe('idle')
  expect(agent.inbox.nextStep.length).toBeGreaterThan(0)
  expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
})

it('routes a blocked edit using the policy workspace when the session has no cwd', async () => {
  const launch = realpathSync(mkdtempSync(join(tmpdir(), 'hmr-launch-')))
  onTestFinished(() => { rmSync(launch, { recursive: true, force: true }) })
  const f = await fixture(undefined, true, launch)
  await mountAgentLoopTestDependencies(f.ctx)
  provideWorkingDirectoryFixture(f.ctx, f.home)
  f.ctx.provide('sandboxPolicy', { workspaceRoot: f.home })
  f.profile.protectedWorkspaceRoot = () => f.ctx.sandboxPolicy.workspaceRoot
  await f.ctx.plugin(ApprovalService)
  const harness = await mountAgentLoopTestHarness(f.ctx)
  const agent = await harness.create(SessionId('policy-workspace'))
  expect(agent.session.header.cwd).toBeUndefined()
  setApprovalPolicy(agent.session, 'never')
  f.commit()
  writeFileSync(f.profile.patchPath, readFileSync(f.profile.patchPath, 'utf8').replace('initial', 'blocked-edit'))
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('initial')
  expect(agent.inbox.nextStep).toHaveLength(1)
  expect(JSON.stringify(agent.session.snapshotEvents())).toContain('Protected host input changed:')
})

it('retains a blocked unattended edit in the session inbox without prompting or starting a turn', async () => {
  const f = await fixture(undefined, true)
  await mountAgentLoopTestDependencies(f.ctx)
  provideWorkingDirectoryFixture(f.ctx)
  await f.ctx.plugin(ApprovalService)
  const harness = await mountAgentLoopTestHarness(f.ctx)
  const agent = await harness.create(SessionId('profile-unattended'), {}, { cwd: f.home })
  setApprovalPolicy(agent.session, 'never')
  f.commit()
  writeFileSync(f.profile.patchPath, readFileSync(f.profile.patchPath, 'utf8').replace('initial', 'unattended-edit'))
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('initial')
  expect(agent.inbox.nextStep).toHaveLength(1)
  expect(JSON.stringify(agent.session.snapshotEvents())).toContain('Protected host input changed:')
  expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  expect(agent.status).toBe('idle')
})

it('applies configuration while a CLI operation holds the package writer lock', async () => {
  const f = await fixture()
  f.commit()
  await withFileLock(join(f.dir, 'package.json'), async () => {
    const original = readFileSync(f.profile.patchPath, 'utf8')
    writeFileSync(f.profile.patchPath, original.replace('initial', 'during-install'))
    f.emit(0, f.profile.patchPath)
    await f.drain()
    expect(f.ctx.get('profileProbe')).toBe('during-install')
  })
})

it('ignores dependency-only manifest changes and reloads a changed bundle list', async () => {
  const f = await fixture()
  f.commit()
  const include = [...f.ctx.loader.entries()].find(entry => entry.id === 'include')!
  const update = vi.spyOn(include, 'update')
  onTestFinished(() => { update.mockRestore() })
  const manifestPath = join(f.dir, 'package.json')
  const manifest = readProfileManifest('test', f.dir)
  manifest.dependencies = { added: '1.0.0' }
  delete manifest.dsh!.profile!.bundles
  writeFileSync(manifestPath, JSON.stringify(manifest))
  f.emit(2, manifestPath)
  await f.drain()
  expect(update).not.toHaveBeenCalled()
  const packageDir = join(f.dir, 'node_modules', 'added')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'added', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(packageDir, 'cordis.patch.yml'), '- insert:\n    - id: bundled\n      name: cordis:probe\n      disabled: true\n')
  manifest.dsh!.profile!.bundles = ['added']
  writeFileSync(manifestPath, JSON.stringify(manifest))
  f.emit(2, manifestPath)
  await f.drain()
  expect(update).toHaveBeenCalledOnce()
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(update).toHaveBeenCalledOnce()
  expect([...f.ctx.loader.entries()].some(entry => entry.id === 'include:bundled')).toBe(true)
})

it('cancels queued reloads when the application exits before readiness', async () => {
  const f = await fixture()
  f.emit(0, f.profile.patchPath)
  await f.ctx.fiber.dispose()
  f.commit()
  expect(f.ctx.get('hmr')).toBeUndefined()
})

it('reports unreadable inputs and recovers after the file is corrected', async () => {
  const f = await fixture()
  f.commit()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const original = readFileSync(f.profile.patchPath, 'utf8')
  rmSync(f.profile.patchPath)
  mkdirSync(f.profile.patchPath)
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(warn).toHaveBeenCalled()
  rmSync(f.profile.patchPath, { recursive: true })
  writeFileSync(f.profile.patchPath, original)
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe(original)
})

it('rejects a profile launcher that omits application readiness', async () => {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(process.cwd() + '/').href
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  ctx.provide('profileContext', {} as ProfileContext)
  await expect(ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })).rejects.toThrow('Profile HMR requires application readiness')
})

it('cancels a queued module notification when startup is interrupted', async () => {
  const f = await fixture()
  const queued = Promise.withResolvers<undefined>()
  const hmr = f.ctx.hmr
  const run = hmr.runExclusive.bind(hmr)
  vi.spyOn(hmr, 'runExclusive').mockImplementation((operation) => { queued.resolve(undefined); return run(operation) })
  watchers.at(-1)!.emit('change', 'pending.mjs')
  await queued.promise
  await f.ctx.fiber.dispose()
  expect(f.ctx.get('hmr')).toBeUndefined()
})

it('logs unchanged inactive entries while applying an unrelated file edit', async () => {
  const f = await fixture()
  f.commit()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const initial = readFileSync(f.profile.patchPath, 'utf8')
  const rows = JSON.parse(initial) as { insert: { id: string; name: string }[] }[]
  rows[0]!.insert.push({ id: 'missing', name: './missing.mjs' })
  writeFileSync(f.profile.patchPath, JSON.stringify(rows))
  f.emit(0, f.profile.patchPath)
  await f.drain()
  warn.mockClear()
  writeFileSync(f.profile.patchPath, JSON.stringify(rows).replace('initial', 'edited'))
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('edited')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing ('))
})

it('applies a patch edited after boot parsing but before watcher registration', async () => {
  const f = await fixture((profile) => {
    const original = readFileSync(profile.patchPath, 'utf8')
    writeFileSync(profile.patchPath, original.replace('initial', 'edited-during-boot'))
  })
  expect(f.ctx.get('profileProbe')).toBe('initial')
  f.commit()
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('edited-during-boot')
})
