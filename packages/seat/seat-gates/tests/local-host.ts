/** Loader composition with real local seats, gates, engine, inbox and Session persistence. */
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import Storage from '@panedesk/dsh-storage'
import { DomainFacility } from '@panedesk/dsh-storage-domain'
import { JsonStorageBackend } from '@panedesk/dsh-storage-json'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import Workspace from '@panedesk/dsh-workspace'
import Title from '@panedesk/dsh-session-title'
import Query from '@panedesk/dsh-session-query-sqlite'
import DefaultModel from '@panedesk/dsh-agent-default-model'
import Attachments from '@panedesk/dsh-attachment-local'
import Access from '@panedesk/dsh-api-remote-access'
import Typert from '@panedesk/dsh-typert-registry'
import Controller from '@panedesk/dsh-api-session-controller'
import Ledger from '@panedesk/dsh-session-ledger'
import Delivery from '@panedesk/dsh-message-delivery-local'
import Permissions from '@panedesk/dsh-permission-presets'
import Approval from '@panedesk/dsh-user-approval'
import Commands from '@panedesk/dsh-commands'
import Sandbox from '@panedesk/dsh-sandbox-policy'
import Questions from '@panedesk/dsh-user-questions'
import Jobs from '@panedesk/dsh-jobs-local'
import * as Subscriptions from '@panedesk/dsh-instruction-subscriptions'
import * as Engine from '@panedesk/dsh-seat-engine'
import * as Local from '@panedesk/dsh-seat-local'
import * as Gates from '../src/index.ts'
import * as Tools from '@panedesk/dsh-tool-seat'
import Subagents from '@panedesk/dsh-subagent'
import * as Spawn from '@panedesk/dsh-subagent-spawn-in-process'
import * as Cache from '@panedesk/dsh-llm-cache'
import type * as T from '@panedesk/dsh-seat'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect } from 'vitest'
import { definition } from '../../seat-local/tests/fixtures.ts'
import { CreationAdapter, UnusedFileUploads, UnusedShell } from '../../seat-local/tests/creation-provider.ts'

export async function localHost(
  model = new CreationAdapter(), gateConfig: Partial<Gates.Config> = {}, subagents = false,
  reportPathsInNotifications = false, jobReportPaths = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'seat-gates-'))
  const ctx = new Context()
  const backend = new JsonStorageBackend(join(root, 'storage'))
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const close = async () => {
    await ctx.fiber.dispose()
    await facility.closeAll()
    await backend.close()
    await rm(root, { recursive: true, force: true })
  }
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    ctx.llm.registerAdapter(['provider-a'], model)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('json', backend)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, persistence: Persistence, workspace: Workspace, title: Title,
      query: Query, defaults: DefaultModel, attachments: Attachments, access: Access, typert: Typert,
      controller: Controller, ledger: Ledger, delivery: Delivery, permissions: Permissions, approval: Approval,
      commands: Commands, sandbox: Sandbox, questions: Questions, jobs: Jobs, uploads: UnusedFileUploads,
      subscriptions: Subscriptions, engine: Engine, local: Local, gates: Gates, tools: Tools, shell: UnusedShell,
      subagents: Subagents, spawn: Spawn, cache: Cache })
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    const load = async (file: string, rows: object[]) => {
      const path = join(root, file)
      await writeFile(path, JSON.stringify(rows))
      const id = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
      await ctx.loader.await()
      return id
    }
    await load('base.yml', [
      { name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
      { name: 'cordis:workspace' }, { name: 'cordis:query', config: { path: join(root, 'query.sqlite'), openAt: 'never' } },
      { name: 'cordis:title', config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } },
      { name: 'cordis:defaults', config: { provider: 'provider-a', model: 'model-a' } },
      { name: 'cordis:attachments', config: { dshHome: root } }, { name: 'cordis:typert' },
      { name: 'cordis:access' }, { name: 'cordis:uploads' },
      { name: 'cordis:ledger', config: { dshHome: root } }, { name: 'cordis:questions' },
      { name: 'cordis:jobs', config: { reportPathsInNotifications: jobReportPaths } }, { name: 'cordis:commands' }, { name: 'cordis:approval' }, { name: 'cordis:shell' },
      { name: 'cordis:subscriptions', config: { maxBytes: 65536, watch: false } },
      { name: 'cordis:sandbox', config: { mode: 'read-only', workspaceRoot: root } },
      { name: 'cordis:permissions', config: { defaultPreset: 'permission-a',
        presets: { 'permission-a': { sandbox: 'workspace-write', approval: 'ask' } } } },
      { name: 'cordis:controller', config: { nativeOpen: false } },
    ])
    const nodeId = await ctx.sessionLedger.nodeId()
    const defaults = definition(root, { autoKeepAlive: false, memoryDirectories: [join(root, 'memory')],
      opening: { kind: 'text', text: 'Open {{seat}}.' } })
    const local: Local.LocalSeatOptions = { directory: root, nodeId, nodeName: 'node-a', nodeAliases: { 'node-a': nodeId },
      defaults, maxSourceBytes: 65536, maxPlans: 20, maxOpeningBytes: 65536, maxBatchSeats: 10,
      pageSize: 1, transactionRetries: 10, maxConfirmations: 10, closedSuffix: ' closed' }
    await load('delivery.yml', [{ name: 'cordis:delivery', config: { dshHome: root, nodeId,
      maxRecordBytes: 1048576, maxContentBytes: 65536, maxBatchSize: 100,
      scanIntervalMs: 1000, lockTimeoutMs: 5000, lockRetryMs: 1, watch: false } }])
    await mountAgentLoopTestHarness(ctx)
    await expect.poll(() => !!ctx.get('sessionCreation')).toBe(true)
    await load('engine.yml', [{ name: 'cordis:engine', config: { home: root, nodeName: 'node-a', nodeAliases: local.nodeAliases,
      dedupWindowMs: 1000, maxDecisionBytes: 200000, maxSourceBytes: 65536, maxBatchSeats: 10, maxCauseDepth: 8,
      budgetTimeZone: 'UTC', callbackTimeoutMs: 1000, callbackMaxResponseBytes: 1000,
      callbackRetryInitialMs: 1, callbackRetryMaxMs: 100, ownerObserveIntervalMs: 1000,
      ownerReleaseBudgetMs: 2000, queueWakeBudgetMs: 1000 } }])
    if (subagents) await load('subagents.yml', [{ name: 'cordis:cache' }, { name: 'cordis:subagents', config: { reportPathsInNotifications } }, { name: 'cordis:spawn' }])
    const entry = await load('seat.yml', [{ name: 'cordis:local', config: local },
      { name: 'cordis:gates', config: gateConfig }, { name: 'cordis:tools', config: {} }])
    await expect.poll(() => !!ctx.get('seatGates') && !!ctx.get('seatLocalRead')).toBe(true)
    await ctx.get('seatEngine')!.ready()
    const seats = ctx.get('seats')!.withAuthority({ principalId: 'user-a' as T.SeatPrincipalId, origin: 'manual', nodeId })
    return { ctx, root, model, seats, defaults, close, load,
      unmount: () => ctx.loader.resolve(entry).fiber!.dispose() }
  } catch (error) { await close(); throw error }
}
