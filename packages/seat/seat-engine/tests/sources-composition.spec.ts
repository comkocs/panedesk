/** Production source registrations drive durable ingress without invoking a model. */
import { expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import Schedule from '@panedesk/dsh-schedule'
import Storage from '@panedesk/dsh-storage'
import * as JsonStorage from '@panedesk/dsh-storage-json'
import * as Domain from '@panedesk/dsh-storage-domain'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { composition } from './composition-fixture.ts'
import { SeatEngine } from '../src/engine.ts'
import { auto, projectId, seat, sourceId, trigger } from './fixtures.ts'
import { SessionId } from '@panedesk/dsh-session'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import type { ProductionSource } from '../src/production-sources.ts'

it('observes closed windows and unanswered handoffs through production timers', async () => {
  const sources: ProductionSource[] = [
    { sourceId: 'ended-source' as never, seat: 'seat-b' as never, projectId,
      trigger: { kind: 'window-ended', seat, on: 'closed' } },
    { sourceId: 'timeout-source' as never, seat, projectId,
      trigger: { kind: 'handoff-timeout', timeoutMinutes: 0.0001 } },
  ]
  const f = await composition(false, { sources })
  try {
    await expect.poll(() => f.ctx.get('subagentAdmission') !== undefined).toBe(true)
    const engine = f.ctx.seatEngine
    if (!(engine instanceof SeatEngine)) throw new Error('Missing production engine')
    engine.registerSource({ sourceId, kinds: ['manual'], maxRedeliveryMs: null, callback: async () => {} })
    engine.registerExecutor({ observe: async open => f.ctx.agents.get(open.sessionId) ? 'matching' : 'absent',
      create: async open => (await f.ctx.agents.create({ sessionId: open.sessionId,
        agentOptions: { provider: 'mock', model: 'model-a' } })).agent.id, configure: async () => {},
      opening: async () => ({ messageId: 'opening-a' as never, state: 'completed' }), owner: async () => 'alive',
      wakeSender: async () => 'unavailable' })
    await auto(engine)
    await engine.accept(trigger('manual'))
    expect((await engine.pending({ limit: 10 })).items.map(item => item.triggerKind)).toContain('manual')
    await engine.drive()
    const open = [...engine.journal.projection.opens.values()][0]
    if (!open) throw new Error('Missing opened window')
    const sender = f.ctx.agents.get(open.sessionId)
    if (!sender) throw new Error('Missing sender')
    const target = (await f.ctx.agents.create({ sessionId: SessionId('target-a'),
      agentOptions: { provider: 'mock', model: 'model-a' } })).agent
    f.adapter.finish()
    await f.ctx.messageDelivery.configure({ sessionId: target.id, settings: { receiveMode: 'all', wakeOnHandoff: false } })
    await f.ctx.agents.withInitiator(sender, () => f.ctx.messageDelivery.send({ target: { sessionId: target.id },
      content: 'Unanswered work', messageClass: 'handoff', operationId: 'handoff-a' as OperationId }))
    await expect.poll(async () => (await engine.pending({ limit: 10 })).items.map(item => item.triggerKind),
      { timeout: 5000 }).toContain('handoff-timeout')
    await engine.recordClosed({ sessionId: open.sessionId, phase: 'closed', reason: 'manual', stateVersion: 2,
      endedAt: new Date().toISOString(), reportId: null, selfReport: null, selfReportStatus: 'not-submitted' })
    await expect.poll(async () => (await engine.pending({ limit: 10 })).items.map(item => item.triggerKind),
      { timeout: 5000 }).toContain('window-ended')
  } finally { await f.close() }
}, 20000)

const execute = promisify(execFile)
const resolver = { apply(ctx: Context) {
  const controller: Pick<Context['sessionController'], 'resolveAgent'> = {
    resolveAgent: async () => { throw new Error('Action must not resolve a session') },
  }
  ctx.provide('sessionController', controller as never)
} }

it('registers the production schedule action and enters the engine queue at its due occurrence', async () => {
  const storageRoot = await mkdtemp(join(process.cwd(), 'packages/seat/seat-engine/tests/.schedule-'))
  const source: ProductionSource = { sourceId: 'schedule-source' as never, seat, projectId, trigger: { kind: 'schedule',
    record: { kind: 'at', id: 'schedule-a' as never, title: 'Open seat', prompt: 'Open seat',
      scheduledAt: new Date(Date.now() + 1000).toISOString() } } }
  const f = await composition(false, { sources: [source], builtins: { schedule: Schedule, storage: Storage,
    json: JsonStorage, domain: Domain, resolver }, entries: [{ name: 'cordis:storage' },
    { name: 'cordis:json', config: { root: storageRoot } }, { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:resolver' }, { name: 'cordis:schedule', config: {} }] })
  try {
    await expect.poll(async () => (await f.ctx.seatEngine.pending({ limit: 10 })).items.map(item => item.triggerKind),
      { timeout: 5000 }).toContain('schedule')
    expect(await f.ctx.schedule.listActions()).toMatchObject([{ lastReceipt: { status: 'accepted' } }])
  } finally { await f.close(); await rm(storageRoot, { recursive: true, force: true }) }
}, 20000)

it('constructs the configured Git observer and queues a registered ref change', async () => {
  const repository = await mkdtemp(join(process.cwd(), 'packages/seat/seat-engine/tests/.git-'))
  await execute('git', ['init', '--bare', repository])
  const empty = (await execute('git', ['hash-object', '-w', '-t', 'tree', '/dev/null'], { cwd: repository })).stdout.trim()
  const commit = async (message: string) => (await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit-tree', empty, '-m', message], { cwd: repository })).stdout.trim()
  await execute('git', ['update-ref', 'refs/heads/main', await commit('initial')], { cwd: repository })
  const source: ProductionSource = { sourceId: 'git-source' as never, seat, projectId,
    trigger: { kind: 'git', repository, repositoryId: 'repo-a', ref: 'refs/heads/main', fallbackMs: 50 } }
  const f = await composition(false, { sources: [source] })
  try {
    await expect.poll(() => f.ctx.seatEngine instanceof SeatEngine
      && f.ctx.seatEngine.journal.projection.git.size).toBe(1)
    await execute('git', ['update-ref', 'refs/heads/main', await commit('next')], { cwd: repository })
    await expect.poll(async () => (await f.ctx.seatEngine.pending({ limit: 10 })).items.map(item => item.triggerKind)).toContain('git')
  } finally { await f.close(); await rm(repository, { recursive: true, force: true }) }
}, 20000)
