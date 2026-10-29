/** Real journal and resource admission with isolated external Session effects. */
import { Context } from '@panedesk/cordis'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import StorageService from '@panedesk/dsh-storage'
import { DomainFacility } from '@panedesk/dsh-storage-domain'
import { JsonStorageBackend } from '@panedesk/dsh-storage-json'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import Workspace from '@panedesk/dsh-workspace'
import SessionTitle from '@panedesk/dsh-session-title'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { SeatEngine, type EngineDependencies } from '@panedesk/dsh-seat-engine'
import type * as T from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { definition, nodeId, operation } from './fixtures.ts'
import { ExactSessionQuery } from './query-provider.ts'
import { LocalEngineState } from '../src/engine-state.ts'
import { localSourceId, admitLocalOpen } from '../src/open-admission.ts'
import { renderOpening } from '../src/template.ts'
import { createLocalRuntime } from '../src/runtime.ts'
import type { LocalSeatOptions } from '../src/service-options.ts'

/** Boot an actual engine through a test-only Loader profile. */
export async function engineFixture(withArchive = false, retainedRoot?: string, engineConfig: Partial<T.SeatEngineConfig> = {}) {
  const root = retainedRoot ?? await mkdtemp(join(tmpdir(), 'seat-engine-local-'))
  const ctx = new Context()
  const backend = new JsonStorageBackend(join(root, 'storage'))
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const def = definition(root, { autoKeepAlive: false })
  const options: LocalSeatOptions = { directory: root, nodeId, nodeName: 'node-a', nodeAliases: { 'node-a': nodeId },
    defaults: def, maxSourceBytes: 65536, maxPlans: 20, maxOpeningBytes: 65536, maxBatchSeats: 10,
    pageSize: 100, transactionRetries: 10, maxConfirmations: 10, closedSuffix: ' closed' }
  const config: T.SeatEngineConfig = { nodeName: 'node-a', nodeAliases: options.nodeAliases, dedupWindowMs: 1000,
    maxDecisionBytes: 200000, maxSourceBytes: 65536, maxBatchSeats: 10, maxCauseDepth: 8, budgetTimeZone: 'UTC',
    callbackTimeoutMs: 1000, callbackMaxResponseBytes: 1000, callbackRetryInitialMs: 1, callbackRetryMaxMs: 100,
    ownerObserveIntervalMs: 1000, ownerReleaseBudgetMs: 2000, queueWakeBudgetMs: 1000, ...engineConfig }
  const created: T.EngineOpenData[] = []
  const renewals: T.SeatOperationId[] = []
  const dependencies: EngineDependencies = {
    seats: () => ctx.get('seats') ?? ({ resolve: async () => def,
      list: async () => ({ status: 'listed', sessions: [], unopenedSeats: [], complete: true, snapshotAt: new Date().toISOString() }),
      close: async () => { throw new Error('Session archive is not installed in this fixture') } }),
    ledger: () => ctx.get('sessionLedger') ?? ({ snapshot: async () => ({ rows: [], complete: true, asOf: 0, watermarks: {} }) }),
    keepalive: { remaining: async () => ({ kind: 'estimated', evidenceAt: Date.now(), ttlSeconds: 3600,
      seconds: 3600 }), renew: async (_sessionId, operationId) => {
      renewals.push(operationId)
      return { kind: 'renewed', evidenceAt: Date.now() }
    } },
  }
  const engines: SeatEngine[] = []
  const plugin = { name: 'local-engine-test', apply(child: Context) {
    child.effect(() => {
      const engine = new SeatEngine(child, { home: root, nodeId, config }, dependencies)
      engines.push(engine)
      return () => engine.shutdown()
    })
  } }
  try {
    if (withArchive) {
      await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
      await ctx.plugin(StorageService)
      ctx.storage.backend.register('json', backend)
      ctx.provide('storageDomain', facility)
    }
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, engine: plugin, persistence: Persistence,
      workspace: Workspace, title: SessionTitle, query: ExactSessionQuery })
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    const path = join(root, 'cordis.yml')
    await writeFile(path, JSON.stringify([
      ...(withArchive ? [{ name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
        { name: 'cordis:workspace' }, { name: 'cordis:query' },
        { name: 'cordis:title', config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } }] : []),
      { name: 'cordis:engine' },
    ]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    const engine = ctx.get('seatEngine')
    if (!(engine instanceof SeatEngine)) throw new Error('Engine did not load')
    await engine.ready()
    const state = new LocalEngineState(() => engine, nodeId, 100, 10)
    const unregisterSource = engine.registerSource({ sourceId: localSourceId, kinds: ['manual'], maxRedeliveryMs: null, callback: async () => {} })
    const executor: T.SeatOpenExecutor = {
      observe: async open => created.some(item => item.sessionId === open.sessionId) ? 'matching' : 'absent',
      create: async (open) => {
        created.push(open)
        if (withArchive) {
          const session = ctx.sessions.create(open.sessionId, { meta: { cwd: root } })
          ctx.sessionTitle.rename(session, open.title ?? def.seat)
          await ctx.sessions.flush(session)
        }
        return open.sessionId
      }, configure: async () => {},
      opening: async () => ({ messageId: 'opening-message' as T.EngineOpenData['openingMessageId'] & string, state: 'completed' }),
      wakeSender: async () => 'unavailable', owner: async () => 'alive',
    }
    const unregister = engine.registerExecutor(executor)
    const open = async (id = 'open-a') => admitLocalOpen(engine, state, {
      request: { seat: def.seat, origin: 'manual', operationId: operation(id), openingMode: 'auto' },
      authority: { principalId: 'user-a' as T.SeatPrincipalId, origin: 'manual', nodeId }, definition: def,
      opening: renderOpening('Frozen opening', { seat: def.seat, date: '2026-01-01', taskId: null }, 4096),
      title: 'seat-a 01-01',
    }, options.nodeName)
    const runtime = createLocalRuntime(ctx, options)
    runtime.evidence = async (_sessionId: SessionId) => ({ complete: true, running: false, approvals: [], planReviews: [],
      answers: [], subagents: [], jobs: [], waits: [], tickets: [], inbox: [], lastConsumedTurn: 'completed',
      droppedUnrun: false, lastActivityAt: null, stateVersion: 1 })
    return { ctx, engine, state, options, definition: def, dependencies, runtime, created, renewals,
      executor, unregister, unregisterSource, open,
      async close() { for (const engine of engines) await engine.shutdown(); await ctx.fiber.dispose()
        await facility.closeAll(); await backend.close()
        if (retainedRoot === undefined) await rm(root, { recursive: true, force: true }) } }
  } catch (error) {
    for (const engine of engines) await engine.shutdown()
    await ctx.fiber.dispose()
    await facility.closeAll(); await backend.close()
    if (retainedRoot === undefined) await rm(root, { recursive: true, force: true })
    throw error
  }
}
