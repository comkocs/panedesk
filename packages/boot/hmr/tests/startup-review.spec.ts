/** Startup agent admission remains synchronous while automatic reloads await Loader settlement. */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import Timer from '@panedesk/cordis-plugin-timer'
import { boot, initProfile, ProtectedInputIntegrity, ProtectedInputReviewError, type ProfileContext } from '@panedesk/dsh-app-boot'
import { FSWatcher } from 'chokidar'
import { expect, it, vi } from 'vitest'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '../../../core/session/src/index.ts'
import { createUserMessage } from '../../../llm/llm/src/index.ts'
import Storage from '../../../storage/storage/src/index.ts'
import * as StorageJson from '../../../storage/storage-json/src/index.ts'
import * as StorageDomain from '../../../storage/storage-domain/src/index.ts'
import * as Persistence from '../../../session/session-persistence-jsonl/src/index.ts'
import WorkspaceRegistry from '../../../workspace/workspace/src/index.ts'
import SessionTitle from '../../../session/session-title/src/index.ts'
import SandboxPolicy from '../../../sandbox/sandbox-policy/src/index.ts'
import SandboxedFileSystem from '../../../fs/fs-sandbox/src/index.ts'
import WorkingDirectory from '../../../session/working-directory/src/index.ts'
import * as ToolFs from '../../../fs/tool-fs/src/index.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '../../../test-support/agent-loop-testkit/src/index.ts'
import Gateway from '../../../api/gateway/src/index.ts'
import TypertRegistry from '../../../typert/registry/src/index.ts'
import RemoteAccess from '../../../api/remote-access/src/index.ts'
import { apply as applyConnection, inject as connectionInject } from '../../../client/connection/src/index.ts'
import { provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ApprovalService from '../../../interaction/user-approval/src/index.ts'
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

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'startup-review-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const dir = join(home, 'profiles', 'test')
  mkdirSync(workspace)
  initProfile(dir, [])
  const config = join(dir, 'cordis.yml')
  writeFileSync(config, '[]\n')
  const integrity = new ProtectedInputIntegrity(workspace, home)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<boolean>()
  const seeded = Promise.withResolvers<Context>()
  const rename = Promise.withResolvers<undefined>()
  const verify = vi.spyOn(integrity, 'verify').mockImplementation(async () => {
    entered.resolve(undefined)
    return release.promise
  })
  const profile: ProfileContext = {
    name: 'test', dir, home, cwd: workspace, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: config, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    inputIntegrity: integrity,
  }
  const listeners = new Set<() => void>()
  let ready = false
  const commit = () => {
    if (ready) return
    ready = true
    for (const listener of [...listeners]) listener()
    listeners.clear()
  }
  const sessionId = SessionId('startup-seed')
  const target = join(workspace, 'written.txt')
  const adapter = new MockAdapter([
    toolCallResponse('startup-write', 'write', { file_path: target, content: 'reviewed' }),
    textResponse('Written.'),
  ])
  let host: Context | undefined
  let renameDone = false
  let renameError: unknown
  const pending = boot('test', config, [{ insert: [
    { id: 'timer', name: 'cordis:timer' },
    { id: 'hmr', name: 'cordis:hmr', config: { root: [] } },
    { id: 'approval', name: 'cordis:approval', config: { policy: 'never' } },
    { id: 'seed', name: 'cordis:seed' },
  ] }], async (ctx) => {
    host = ctx
    ctx.provide('appReady', { onReady(listener) {
      if (ready) { listener(); return () => {} }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    } })
    await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(home, 'storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 80, maxTitleBytes: 80 })
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace })
    await ctx.plugin(ToolFs)
    await mountAgentLoopTestHarness(ctx)
    ctx.llm.registerAdapter(['startup-fixture'], adapter)
    provideBrowserCredentials(ctx)
    await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccess)
    await ctx.plugin(Gateway)
    createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'startup-fixture', model: 'scripted' }), cwd: workspace,
    })
    ctx.provide('profileContext', profile)
    ctx.on('agent/created', ({ agent }) => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write written.txt.' }], source: { kind: 'user' } }))
    }, { prepend: true })
    Object.assign(ctx.loader.builtins, {
      timer: Timer, hmr: Hmr, approval: ApprovalService,
      seed: {
        inject: ['hmr', 'approval', 'sessionPersistence', 'workspaceRegistry', 'sessionController'],
        async apply(seed: Context) {
          const handle = await seed.sessionPersistence.create({
            version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: Date.now(), isSeeded: false, cwd: workspace,
          })
          try {
            await handle.append([
              { type: 'turn/start', seq: SessionSeq(0), time: Date.now(), data: { turn: 1 } },
              { type: 'turn/end', seq: SessionSeq(1), time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
            ])
          } finally { await handle.close() }
          const attached = await seed.workspaceRegistry.create(workspace)
          await attached.attachSession(sessionId)
          seeded.resolve(seed)
          await rename.promise
          try {
            await seed.sessionController.rename({ sessionId, title: 'Startup seed' })
            renameDone = true
          } catch (error) { renameError = error }
        },
      },
    })
  }).then((ctx) => { commit(); return ctx })
  void pending.catch((error: unknown) => { seeded.reject(error) })
  return {
    pending, seeded, rename, entered, release, verify, adapter, target, sessionId,
    state: () => ({ renameDone, renameError, ready }),
    async dispose() {
      release.resolve(false)
      rename.resolve(undefined)
      commit()
      await pending
      await host?.fiber.dispose()
      verify.mockRestore()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

it.each([true, false])('settles startup create, attach and rename without a readiness lock cycle; review accepted: %s', async (accepted) => {
  const f = await fixture()
  try {
    const ctx = await f.seeded.promise
    const held = Promise.withResolvers<undefined>()
    const unlock = Promise.withResolvers<undefined>()
    const holding = ctx.hmr.runExclusive(async () => { held.resolve(undefined); await unlock.promise })
    await held.promise
    const trigger = join(ctx.profileContext.home, 'reload-trigger')
    const refreshed = vi.fn(async () => {})
    await ctx.hmr.watchConfig(trigger, refreshed)
    const watcher = watchers.at(-1)
    if (watcher === undefined) throw new Error('Configuration watcher was not registered')
    const queued = vi.spyOn(Hmr.prototype, 'runExclusive')
    const mutation = vi.fn()
    ctx.on('tools/execute', (_call, next) => { mutation(); return next() }, { prepend: true })
    try {
      watcher.emit('change', trigger)
      expect(queued).toHaveBeenCalledOnce()
      expect(refreshed).not.toHaveBeenCalled()
      const reviewQueued = Promise.withResolvers<undefined>()
      const runReview = ctx.profileContext.runInputReview
      if (runReview === undefined) throw new Error('HMR review callback was not registered')
      ctx.profileContext.runInputReview = (operation) => { reviewQueued.resolve(undefined); return runReview(operation) }
      f.rename.resolve(undefined)
      unlock.resolve(undefined)
      await holding
      expect(await Promise.race([
        f.entered.promise.then(() => 'review-entered'),
        reviewQueued.promise.then(() => 'review-queued-behind-readiness'),
      ])).toBe('review-entered')
      expect(f.state()).toEqual({ renameDone: false, renameError: undefined, ready: false })
      expect(f.adapter.requests).toHaveLength(0)
      expect(mutation).not.toHaveBeenCalled()
      expect(existsSync(f.target)).toBe(false)
      f.release.resolve(accepted)
      const host = await f.pending
      expect(f.state().ready).toBe(true)
      if (accepted) {
        expect(f.state().renameDone).toBe(true)
        expect(f.state().renameError).toBeUndefined()
        expect(host.sessions.get(f.sessionId)?.snapshotEvents().find(event => event.type === 'session/title')?.data.title).toBe('Startup seed')
      } else {
        expect(f.state().renameDone).toBe(false)
        expect(String(f.state().renameError)).toContain(new ProtectedInputReviewError().message)
        expect(host.agents.get(f.sessionId)).toBeUndefined()
        expect(f.adapter.requests).toHaveLength(0)
        expect(mutation).not.toHaveBeenCalled()
        expect(existsSync(f.target)).toBe(false)
      }
    } finally {
      unlock.resolve(undefined)
      await holding
      queued.mockRestore()
      mutation.mockRestore()
    }
  } finally { await f.dispose() }
})
