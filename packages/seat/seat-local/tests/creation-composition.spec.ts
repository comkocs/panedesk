/** Public controlled creation is composed through Loader, never a private controller import. */
import { expect, it, onTestFinished } from 'vitest'
import type { Context } from '@panedesk/cordis'
import DefaultModel from '@panedesk/dsh-agent-default-model'
import Attachments from '@panedesk/dsh-attachment-local'
import RemoteAccess from '@panedesk/dsh-api-remote-access'
import Typert from '@panedesk/dsh-typert-registry'
import SessionController from '@panedesk/dsh-api-session-controller'
import Ledger from '@panedesk/dsh-session-ledger'
import Delivery from '@panedesk/dsh-message-delivery-local'
import Permissions from '@panedesk/dsh-permission-presets'
import Approval from '@panedesk/dsh-user-approval'
import Commands from '@panedesk/dsh-commands'
import SandboxPolicy from '@panedesk/dsh-sandbox-policy'
import * as Subscriptions from '@panedesk/dsh-instruction-subscriptions'
import { mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { engineFixture } from './engine-fixture.ts'
import { UnusedFileUploads, UnusedShell, CreationAdapter } from './creation-provider.ts'
import { createOpenExecutor } from '../src/executor.ts'
import { recordCost } from './ledger-call.ts'
import { checkWaitDelivery } from './wait-delivery-composition.ts'
import { checkScheduleDeletion } from './schedule-composition.ts'
import { checkContextEpoch } from './context-composition.ts'
import { checkChildContext } from './child-context-composition.ts'
import { checkWindowEcho } from './window-echo-composition.ts'
import { checkReplacement } from './replacement-composition.ts'
import { checkFrozenPrefill } from './frozen-composition.ts'
import { checkDirectories } from './directory-composition.ts'
import type * as T from '@panedesk/dsh-seat'
import { operation } from './fixtures.ts'
import * as Local from '../src/index.ts'

it.each(['budget', 'opening', 'prefill', 'wait-replay'] as const)('creates and restores the same Session through public services: %s', async (scenario) => {
  const f = await engineFixture(true)
  try {
    f.definition.contextThresholdTokens = 60
    f.definition.subagentContextThresholdTokens = 90
    f.definition.rules = [{ id: 'manual-label' as T.SeatRuleId, enabled: true, trigger: { kind: 'manual', origin: 'manual' },
      timeWindows: [], exclusiveTags: ['resource-a'] }]
    const adapter = new CreationAdapter()
    f.ctx.llm.registerAdapter(['provider-a'], adapter)
    Object.assign(f.ctx.loader.builtins, { defaults: DefaultModel, attachments: Attachments, access: RemoteAccess,
      typert: Typert, controller: SessionController, uploads: UnusedFileUploads, ledger: Ledger,
      subscriptions: Subscriptions, delivery: Delivery, permissions: Permissions, approval: Approval,
      commands: Commands, sandbox: SandboxPolicy, shell: UnusedShell })
    const path = join(f.options.directory, 'creation.yml')
    await writeFile(path, JSON.stringify([
      { name: 'cordis:defaults', config: { provider: 'provider-a', model: 'model-a' } },
      { name: 'cordis:attachments', config: { dshHome: f.options.directory } },
      { name: 'cordis:typert' }, { name: 'cordis:access' }, { name: 'cordis:uploads' },
      { name: 'cordis:ledger', config: { dshHome: f.options.directory } },
      { name: 'cordis:delivery', config: { dshHome: f.options.directory, nodeId: f.options.nodeId,
        maxRecordBytes: 1048576, maxContentBytes: 65536,
        maxBatchSize: 100, scanIntervalMs: 1000, lockTimeoutMs: 5000, lockRetryMs: 1, watch: false } },
      { name: 'cordis:subscriptions', config: { maxBytes: 65536, watch: false } },
      { name: 'cordis:commands' }, { name: 'cordis:shell' }, { name: 'cordis:approval' },
      { name: 'cordis:sandbox', config: { mode: 'read-only', workspaceRoot: f.options.directory } },
      { name: 'cordis:permissions', config: { defaultPreset: 'permission-a',
        presets: { 'permission-a': { sandbox: 'workspace-write', approval: 'ask' } } } },
      { name: 'cordis:controller', config: { nativeOpen: false } },
    ]))
    await f.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await f.ctx.loader.await()
    const loopOwner = { name: 'seat-creation-loop-owner', apply: (ctx: Context) => mountAgentLoopTestHarness(ctx).then(() => {}) }
    const loop = await f.ctx.plugin(loopOwner)
    expect(f.ctx.get('sessionCreation')).toBeDefined()
    expect(f.ctx.get('fs')).toBeDefined()
    expect(f.ctx.get('messageDelivery')).toBeDefined()
    await f.unregister()
    const executor = createOpenExecutor(f.ctx, f.runtime, f.options)
    let unloadLocal: (() => Promise<() => Promise<void>>) | undefined
    {
      await f.unregisterSource()
      f.ctx.loader.builtins.local = Local
      const localPath = join(f.options.directory, 'local.yml')
      await writeFile(localPath, JSON.stringify([{ name: 'cordis:local', config: f.options }]))
      const entry = await f.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(localPath).href } })
      await f.ctx.loader.await()
      await expect.poll(() => f.ctx.get('seats') !== undefined).toBe(true)
      unloadLocal = async () => {
        await f.ctx.loader.resolve(entry).fiber?.dispose()
        return async () => {
          await f.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(localPath).href } })
          await f.ctx.loader.await()
          await expect.poll(() => f.ctx.get('seats') !== undefined).toBe(true)
        }
      }
    }
    const seats = f.ctx.get('seats')?.withAuthority({ principalId: 'creation-owner' as T.SeatPrincipalId,
      origin: 'manual', nodeId: f.options.nodeId })
    if (seats) {
      f.definition.opening = { kind: 'text', text: 'Frozen opening' }
      f.definition.wakeTemplate = { kind: 'text', text: 'Continue {{seat}}' }
      expect(await seats.setAuthority({ authority: 'seat-store', authorizationRef: 'creation-owner' as T.AuthorizationRef,
        expectedRevision: 0, operationId: operation('authorize-creation') })).toMatchObject({ status: 'saved' })
      expect(await seats.save({ definition: f.definition, expectedRevision: 1, operationId: operation('save-creation') }))
        .toMatchObject({ status: 'saved' })
    }
    if (scenario === 'prefill') {
      if (!seats) throw new Error('Local provider is unavailable')
      await checkFrozenPrefill(f, seats, adapter)
      return
    }
    const openingRequest = { seat: f.definition.seat, origin: 'manual' as const, operationId: operation('open-a'), openingMode: 'auto' as const }
    const releaseOpening = scenario === 'budget'
      ? f.ctx.on('agent/turn-admitting', async (_request, next) => {
        await next(); return { kind: 'defer', reason: 'Inspect budget revision during original opening.' }
      }) : () => {}
    const openingCompleted = Promise.withResolvers<undefined>()
    if (scenario === 'wait-replay') {
      const off = f.ctx.on('session/event', (_session, event) => {
        if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
          off()
          openingCompleted.resolve(undefined)
        }
      })
      onTestFinished(() => { off() })
    }
    const opened = seats ? await seats.open(openingRequest) : await f.open()
    if (opened.status !== 'opened') throw new Error('Controlled opening did not create a window')
    expect(f.ctx.agents.get(opened.sessionId)?.id).toBe(opened.sessionId)
    const saved = await f.ctx.sessionPersistence.stat(opened.sessionId)
    expect(saved?.header.cwd).toBe(f.options.directory)
    const before = await f.ctx.sessionLedger.query({ sessionId: opened.sessionId })
    const runs = before.rows.filter(row => row.kind === 'run')
    expect(runs).toHaveLength(1)
    const open = (await f.state.read()).effects.findLast(effect => effect.kind === 'open/configured')
    if (open?.kind !== 'open/configured') throw new Error('Open facts are missing')
    expect(open.data.sessionId).toBe(opened.sessionId)
    if (scenario === 'wait-replay') {
      await openingCompleted.promise
      await f.ctx.agents.get(opened.sessionId)?.whenIdle()
      await checkScheduleDeletion(f, opened.sessionId, adapter)
      return
    }
    if (scenario === 'opening') {
      await expect.poll(() => adapter.requests.length).toBe(1)
      await f.ctx.agents.get(opened.sessionId)?.whenIdle()
      await expect.poll(async () => {
        await f.engine.drive()
        const latest = (await f.state.read()).effects.findLast(effect => effect.kind === 'open/configured')
        return latest?.kind === 'open/configured' ? latest.data.phase : undefined
      }).toBe('active')
      const active = (await f.state.read()).effects.findLast(effect => effect.kind === 'open/configured')
      if (active?.kind !== 'open/configured') throw new Error('Configured opening is unavailable')
      expect(active.data.phase).toBe('active')
      expect(await executor.replacementFirstTurn?.(active.data)).toMatchObject({ messageId: active.data.openingMessageId,
        completed: true, hasAssistantReply: true })
      expect(JSON.stringify(adapter.requests[0])).toContain('Frozen opening')
      expect(await seats?.open(openingRequest)).toMatchObject({ status: 'opened', sessionId: opened.sessionId })
      expect(adapter.requests).toHaveLength(1)
      if (!unloadLocal) throw new Error('Local provider lifecycle is unavailable')
      await checkWaitDelivery(f, opened.sessionId, adapter, unloadLocal)
      await checkScheduleDeletion(f, opened.sessionId, adapter)
      await checkContextEpoch(f, opened.sessionId, adapter)
      await checkChildContext(f, opened.sessionId)
      await checkWindowEcho(f, opened.sessionId, adapter)
    } else {
      await checkDirectories(f, opened.sessionId)
      expect(f.engine.journal.projection.opens.get(opened.sessionId)?.phase).toBe('opening-pending')
      const releaseTurn = f.ctx.on('agent/turn-admitting', () => ({ kind: 'defer', reason: 'Inspect durable budget delivery.' }))
      try {
        expect(await f.engine.configureBudget({ sessionId: opened.sessionId, limits: { windowBudgetUsd: '100' as T.MicroUsd },
          expectedRevision: 0, authorizationRef: 'test-budget' as T.AuthorizationRef,
          operationId: operation('budget-config') })).toMatchObject({ status: 'configured' })
        await recordCost(f.ctx, opened.sessionId, 'budget-cost', '0.00008')
        expect(await f.engine.budget(opened.sessionId)).toMatchObject({ costState: 'known', windowCost: '80' })
        await f.engine.drive()
        await f.engine.drive()
        const warnings = (await f.state.read()).effects.filter(effect => effect.kind === 'budget/warning')
        expect(warnings).toHaveLength(1)
        const agent = f.ctx.agents.get(opened.sessionId)
        if (!agent) throw new Error('Budget target disappeared')
        await expect.poll(() => agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
        && JSON.stringify(event.data).includes('budget-warning')).length).toBe(1)
        await f.ctx.sessions.flush(agent.session)
        expect(JSON.stringify((await f.ctx.sessionQuery.readSession(opened.sessionId))?.events)).toContain('budget-warning')
      } finally { releaseTurn(); releaseOpening() }
    }
    await loop.dispose()
    expect(f.ctx.agents.get(opened.sessionId)).toBeUndefined()
    await f.ctx.plugin(loopOwner)
    await executor.configure(open.data, 'workspace')
    expect(f.ctx.agents.get(opened.sessionId)?.id).toBe(opened.sessionId)
    const restored = (await f.ctx.sessionLedger.query({ sessionId: opened.sessionId })).rows.filter(row => row.kind === 'run')
    expect(restored).toHaveLength(2)
    expect(new Set(restored.map(row => row.start.runId)).size).toBe(2)
    expect(restored.every(row => row.start.sessionId === opened.sessionId)).toBe(true)
    expect((await f.ctx.sessionPersistence.stat(opened.sessionId))?.header.cwd).toBe(f.options.directory)
    if (scenario === 'opening') await checkReplacement(f, opened.sessionId)
  } finally { await f.close() }
}, 15000)
