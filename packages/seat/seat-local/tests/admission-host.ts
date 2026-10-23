/** Real Loader, local provider, engine and Session creation with an external model adapter. */
import { type Context } from '@panedesk/cordis'
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
import Questions from '@panedesk/dsh-user-questions'
import Jobs from '@panedesk/dsh-jobs-local'
import * as Subscriptions from '@panedesk/dsh-instruction-subscriptions'
import { mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { engineFixture } from './engine-fixture.ts'
import { UnusedFileUploads, UnusedShell, CreationAdapter } from './creation-provider.ts'
import type * as T from '@panedesk/dsh-seat'
import { operation } from './fixtures.ts'
import * as Local from '../src/index.ts'

export async function admissionHost(retainedRoot?: string) {
  const f = await engineFixture(true, retainedRoot)
  try {
    const adapter = new CreationAdapter()
    f.ctx.llm.registerAdapter(['provider-a'], adapter)
    Object.assign(f.ctx.loader.builtins, { defaults: DefaultModel, attachments: Attachments, access: RemoteAccess,
      typert: Typert, controller: SessionController, uploads: UnusedFileUploads, ledger: Ledger,
      subscriptions: Subscriptions, delivery: Delivery, permissions: Permissions, approval: Approval,
      commands: Commands, sandbox: SandboxPolicy, shell: UnusedShell, questions: Questions, jobs: Jobs, local: Local })
    const load = async (file: string, rows: object[]) => {
      const path = join(f.options.directory, file)
      await writeFile(path, JSON.stringify(rows))
      const entry = await f.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
      await f.ctx.loader.await()
      return entry
    }
    await load('admission-base.yml', [
      { name: 'cordis:defaults', config: { provider: 'provider-a', model: 'model-a' } },
      { name: 'cordis:attachments', config: { dshHome: f.options.directory } },
      { name: 'cordis:typert' }, { name: 'cordis:access' }, { name: 'cordis:uploads' },
      { name: 'cordis:ledger', config: { dshHome: f.options.directory } },
      { name: 'cordis:delivery', config: { dshHome: f.options.directory, nodeId: f.options.nodeId,
        maxRecordBytes: 1048576, maxContentBytes: 65536, maxBatchSize: 100,
        scanIntervalMs: 1000, lockTimeoutMs: 5000, lockRetryMs: 1, watch: false } },
      { name: 'cordis:subscriptions', config: { maxBytes: 65536, watch: false } },
      { name: 'cordis:commands' }, { name: 'cordis:shell' }, { name: 'cordis:approval' },
      { name: 'cordis:questions' }, { name: 'cordis:jobs' },
      { name: 'cordis:sandbox', config: { mode: 'read-only', workspaceRoot: f.options.directory } },
      { name: 'cordis:permissions', config: { defaultPreset: 'permission-a',
        presets: { 'permission-a': { sandbox: 'workspace-write', approval: 'ask' } } } },
      { name: 'cordis:controller', config: { nativeOpen: false } },
    ])
    await f.ctx.plugin({ name: 'admission-loop', apply: (ctx: Context) => mountAgentLoopTestHarness(ctx).then(() => {}) })
    await f.unregister(); await f.unregisterSource()
    const ready = () => {
      const result = Promise.withResolvers<undefined>()
      f.ctx.inject(['seatLocalRead', 'seatWorktreeHost', 'seatReminderHost'], () => { result.resolve(undefined) })
      return result.promise
    }
    const waiting = ready()
    let entry = await load('admission-local.yml', [{ name: 'cordis:local', config: f.options }])
    await waiting
    const authority: T.SeatCallContext = { principalId: 'user-a' as T.SeatPrincipalId, origin: 'manual', nodeId: f.options.nodeId }
    const seats = f.ctx.get('seats')!.withAuthority(authority)
    await seats.setAuthority({ authority: 'seat-store', authorizationRef: 'user-a' as T.AuthorizationRef,
      expectedRevision: 0, operationId: operation('authority') })
    await seats.save({ definition: f.definition, expectedRevision: 1, operationId: operation('save-a') })
    return { ...f, adapter, seats, authority, load, async reload() {
      await f.ctx.loader.resolve(entry).fiber?.dispose()
      const waiting = ready()
      entry = await load('admission-local.yml', [{ name: 'cordis:local', config: f.options }])
      await waiting
      return f.ctx.get('seats')!.withAuthority(authority)
    } }
  } catch (error) { await f.close(); throw error }
}
