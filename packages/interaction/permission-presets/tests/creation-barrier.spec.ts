/** Permission preparation belongs to the composite creation transaction. */
import { Context } from '@panedesk/cordis'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import type { Session } from '@panedesk/dsh-session'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import { expect, it, onTestFinished, vi } from 'vitest'
import PermissionPresetService from '../src/index.ts'

it('completes permission preparation before notifying session observers', async () => {
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined)
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx)
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  ctx.provide('approval', { config: { policy: 'ask' } })
  await ctx.plugin(PermissionPresetService)
  await ctx.plugin(AgentLoop, { agents: [] })
  const initialize = ctx.permissionPresets.initialize.bind(ctx.permissionPresets)
  vi.spyOn(ctx.permissionPresets, 'initialize').mockImplementation(async (session, override, signal) => {
    entered.resolve(undefined)
    await release.promise
    await initialize(session, override, signal)
  })
  const observed: unknown[] = []
  ctx.on('session/created', (session) => {
    observed.push(session.snapshotEvents().map(event => [event.type, event.data]))
  })
  const creating = ctx.agents.create({ sessionId: SessionId('permission-creation-barrier') })
  try {
    await entered.promise
    release.resolve(undefined)
    await creating
    expect(observed).toEqual([[
      ['permission/preset', { preset: 'workspace-write' }],
      ['sandbox/mode', { mode: 'workspace-write' }],
      ['approval/policy', { policy: 'ask' }],
    ]])
  } finally {
    release.resolve(undefined)
    await creating
  }
})

it.each(['failure', 'cancel'] as const)('does not publish permission facts after capture %s', async (outcome) => {
  const root = await mkdtemp(join(tmpdir(), 'permission-preparation-'))
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const captureFailure = new Error('permission capture failed')
  const capture = vi.spyOn(ProtectedInputIntegrity.prototype, 'ensureWrite').mockImplementation(async () => {
    entered.resolve(undefined)
    await release.promise
    if (outcome === 'failure') throw captureFailure
  })
  onTestFinished(async () => {
    release.resolve(undefined)
    capture.mockRestore()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  ctx.provide('approval', { config: { policy: 'ask' } })
  ctx.provide('profileContext', {
    name: 'test', dir: root, patchPath: join(root, 'cordis.patch.yml'), home: join(root, 'home'), cwd: root,
    installAnchor: join(root, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  await ctx.plugin(Persistence, { root: join(root, 'sessions') })
  await ctx.plugin(PermissionPresetService)
  await ctx.plugin(AgentLoop, { agents: [] })
  const caller = new AbortController()
  let unpublished: Session | undefined
  const observed: string[] = []
  ctx.on('session/created', () => { observed.push('session') })
  ctx.on('agent/created', () => { observed.push('agent') })
  const creating = ctx.agents.create({
    sessionId: SessionId(`permission-capture-${outcome}`), meta: { cwd: root }, signal: caller.signal,
    setup(_agentCtx, agent) { unpublished = agent.session },
  })
  const rejected = expect(creating).rejects.toThrow(outcome === 'failure' ? captureFailure : 'permission creation cancelled')
  await entered.promise
  expect(unpublished?.snapshotEvents()).toEqual([])
  expect(observed).toEqual([])
  if (outcome === 'cancel') caller.abort(new Error('permission creation cancelled'))
  release.resolve(undefined)
  await rejected
  expect(unpublished?.snapshotEvents()).toEqual([])
  expect(observed).toEqual([])
  expect(ctx.sessions.list()).toEqual([])
  expect(ctx.agents.list()).toEqual([])
  expect(await ctx.sessionPersistence.list()).toEqual([])
})
