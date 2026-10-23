/** Loader-owned seat providers over real Session, storage, delivery and agent services. */
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include, { entryListSchema } from '@panedesk/cordis-plugin-include'
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
import * as Connection from '@panedesk/dsh-client-connection'
import Credentials from '@panedesk/dsh-credentials-local'
import Uploads from '@panedesk/dsh-client-file-upload'
import * as Subscriptions from '@panedesk/dsh-instruction-subscriptions'
import * as Engine from '@panedesk/dsh-seat-engine'
import * as Local from '@panedesk/dsh-seat-local'
import * as Gates from '@panedesk/dsh-seat-gates'
import * as Tools from '@panedesk/dsh-tool-seat'
import Remote from '@panedesk/dsh-seat-remote'
import * as App from '../../src/index.ts'
import Schedule from '@panedesk/dsh-schedule'
import { load as loadYaml } from 'js-yaml'
import type * as T from '@panedesk/dsh-seat'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

async function until(check: () => boolean) {
  const deadline = performance.now() + 5000
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('Provider readiness deadline exceeded')
    await delay(10)
  }
}
import { deployment } from './e2e-config.ts'
import { SeatModel } from './e2e-model.ts'
import * as Shell from './e2e-shell.ts'

export async function createHost(existingRoot?: string) {
  const parent = process.env.PANEDESK_HOME ?? process.cwd()
  await mkdir(parent, { recursive: true })
  const root = existingRoot ?? await mkdtemp(join(parent, 'seat-e2e-'))
  const ctx = new Context()
  const backend = new JsonStorageBackend(join(root, 'storage'))
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const ready = new Set<() => void>()
  const model = new SeatModel()
  const close = async () => {
    await ctx.fiber.dispose()
    await facility.closeAll()
    await backend.close()
    if (!existingRoot) await rm(root, { recursive: true, force: true })
  }
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    ctx.llm.registerAdapter(['provider-a'], model)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('json', backend)
    ctx.provide('storageDomain', facility)
    ctx.provide('cmdlineArgs', { get: () => ['--help'], set: () => {} })
    ctx.provide('appReady', { onReady: (callback) => { ready.add(callback); return () => { ready.delete(callback) } } })
    ctx.provide('appExit', () => {})
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, persistence: Persistence, workspace: Workspace, title: Title,
      query: Query, defaults: DefaultModel, attachments: Attachments, access: Access, typert: Typert,
      controller: Controller, ledger: Ledger, delivery: Delivery, permissions: Permissions, approval: Approval,
      commands: Commands, sandbox: Sandbox, questions: Questions, jobs: Jobs, connection: Connection, credentials: Credentials,
      uploads: Uploads, subscriptions: Subscriptions, engine: Engine, local: Local, gates: Gates, tools: Tools,
      remote: Remote, app: App, shell: Shell, schedule: Schedule,
      '@panedesk/dsh-seat-engine': Engine, '@panedesk/dsh-seat-local': Local,
      '@panedesk/dsh-seat-gates': Gates, '@panedesk/dsh-tool-seat': Tools,
      '@panedesk/dsh-seat-remote': Remote, '@panedesk/dsh-seat-app': App })
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
      { name: 'cordis:access' }, { name: 'cordis:credentials', config: { dshHome: root, watch: false } },
      { name: 'cordis:connection' }, { name: 'cordis:uploads' },
      { name: 'cordis:ledger', config: { dshHome: root } }, { name: 'cordis:questions' },
      { name: 'cordis:jobs' }, { name: 'cordis:commands' }, { name: 'cordis:approval' }, { name: 'cordis:shell' },
      { name: 'cordis:subscriptions', config: { maxBytes: 65536, watch: false } },
      { name: 'cordis:sandbox', config: { mode: 'read-only', workspaceRoot: root } },
      { name: 'cordis:permissions', config: { defaultPreset: 'permission-a',
        presets: { 'permission-a': { sandbox: 'workspace-write', approval: 'ask' } } } },
      { name: 'cordis:controller', config: { nativeOpen: false } }, { name: 'cordis:schedule' },
    ])
    const nodeId = await ctx.sessionLedger.nodeId()
    const config = deployment(root, nodeId)
    await load('delivery.yml', [{ name: 'cordis:delivery', config: { dshHome: root, nodeId,
      maxRecordBytes: 1048576, maxContentBytes: 65536, maxBatchSize: 100,
      scanIntervalMs: 1000, lockTimeoutMs: 5000, lockRetryMs: 1, watch: false } }])
    await mountAgentLoopTestHarness(ctx)
    const required = ['agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'fs', 'llm', 'remoteAccess',
      'sessions', 'sessionProjections', 'sessionQuery', 'typert', 'workspaceRegistry', 'credentials', 'connection'] as const
    assert.deepEqual(required.filter(name => !ctx.get(name)), [], 'Missing production dependencies')
    await until(() => !!ctx.get('sessionCreation'))
    let entry: string | undefined
    const mount = async () => {
      const patch = loadYaml(await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema }) as
        { insert?: { id: string; name: string; disabled?: boolean }[] }[]
      const names = ['seat-engine', 'seat-local', 'seat-gates', 'tool-seat', 'seat-remote', 'seat-app']
      const rows = patch.flatMap(row => row.insert ?? []).filter(row => names.includes(row.id))
      assert.deepEqual(rows.map(row => row.id), names)
      entry = await load('seat.yml', rows.map(row => ({ id: row.id, name: `cordis:${row.name}`,
        config: row.id === 'seat-engine' ? config.engine : row.id === 'seat-local' ? config.local : {} })))
      await until(() => !!ctx.get('seats') && !!ctx.get('seatEngine') && !!ctx.get('seatGates'))
      await ctx.get('seatEngine')!.ready()
    }
    const unmount = async () => {
      if (entry !== undefined) await ctx.loader.resolve(entry).fiber?.dispose()
      entry = undefined
    }
    const seats = () => ctx.get('seats')!.withAuthority({ principalId: 'user-a' as T.SeatPrincipalId, origin: 'manual', nodeId })
    return { ctx, root, config, model, ready, seats, mount, unmount, close }
  } catch (error) { await close(); throw error }
}
