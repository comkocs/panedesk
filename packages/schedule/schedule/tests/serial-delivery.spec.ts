/** Schedule owns its record schema, so the creation-ordering integration runs here beside the storage it seeds. */
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import * as JsonlSessionPersistence from '@panedesk/dsh-session-persistence-jsonl'
import Storage from '@panedesk/dsh-storage'
import * as StorageDomain from '@panedesk/dsh-storage-domain'
import * as StorageJson from '@panedesk/dsh-storage-json'
import { createAfterScheduleRecord, createEveryScheduleRecord, ScheduleId } from '../src/domain.ts'
import ScheduleService from '../src/index.ts'
import { scheduleDomain } from '../src/storage.ts'

class ClockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 } })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Reminder received.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const liveEverySeconds = Number(process.env['DSH_SCHEDULE_LIVE_EVERY_SECONDS'] ?? 60)
const liveFullIntervals = process.env['DSH_SCHEDULE_LIVE_FULL_INTERVALS'] === '1'
const liveDurationMs = liveEverySeconds * 1000 * (liveFullIntervals ? 2 : 1)
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function core(persistenceRoot: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('due delivery during Agent creation', () => {
  it('restores a cold session and starts two fixed-rate turns on the real host clock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-every-live-'))
    roots.push(root)
    const ctx = await core(join(root, 'sessions'))
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'schedule-storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const model = new ClockAdapter()
    ctx.llm.registerAdapter(['clock'], model)
    const sessionId = SessionId('every-cold-session')
    const original = await ctx.agents.create({ sessionId, agentOptions: { provider: 'clock', model: 'clock-model' } })
    await ctx.sessions.flush(original.agent.session)
    await original.dispose()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    const record = createEveryScheduleRecord(ScheduleId('every-live'), 'EVERY_LIVE_MARKER', liveEverySeconds,
      Date.now() - (liveFullIntervals ? 0 : liveEverySeconds * 1000 - 100), 'Live every')
    const seeded = await ctx.storageDomain.open(scheduleDomain)
    await seeded.table('tasks').put(record.id, { sessionId, record, status: 'active' })
    await seeded.close()
    let resolutions = 0
    ctx.provide('sessionController', {
      resolveAgent: async (bound: SessionId) => {
        expect(bound).toBe(sessionId)
        resolutions++
        const live = ctx.agents.get(bound) ?? (await ctx.agents.resume({
          resumeSessionId: bound, agentOptions: { provider: 'clock', model: 'clock-model' },
        })).agent
        return { agent: live }
      },
    } as never)
    let turns = 0
    ctx.on('session/event', (session, event) => {
      if (session.id === sessionId && event.type === 'turn/start') turns++
    })
    const started = performance.now()
    await ctx.plugin(ScheduleService)
    await expect.poll(() => turns, { timeout: liveDurationMs + 5000, interval: 100 }).toBe(2)
    expect(resolutions).toBe(2)
    expect(performance.now() - started).toBeGreaterThanOrEqual(liveDurationMs - 1000)
    const live = ctx.agents.get(sessionId)!
    await live.whenIdle()
    expect(model.requests).toHaveLength(2)
    const [entry] = await ctx.schedule.catalog()
    expect(entry?.kind).toBe('every')
    expect(JSON.stringify(ctx.agents.get(sessionId)?.session.deriveMessages())).toContain('EVERY_LIVE_MARKER')
    console.log('Real host clock:', JSON.stringify({ everySeconds: liveEverySeconds, turns, resolutions,
      requests: model.requests.length, elapsedMs: performance.now() - started }))
  }, liveDurationMs + 15000)

  it('enqueues the reminder without starting a turn before every creation listener finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-serial-'))
    roots.push(root)
    const ctx = await core(join(root, 'sessions'))
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'schedule-storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const sessionId = SessionId('serial-delivery')
    const id = ScheduleId('due')
    const record = createAfterScheduleRecord(id, 'Due reminder', 1, Date.now() - 2_000, 'Due reminder')
    const seeded = await ctx.storageDomain.open(scheduleDomain)
    await seeded.table('tasks').put(record.id, { sessionId, record, status: 'active' })
    await seeded.close()
    const available = Promise.withResolvers<Agent>()
    // The resolver returns the Agent while its serial publication listeners are blocked.
    ctx.provide('sessionController', {
      resolveAgent: async (bound: SessionId) => {
        expect(bound).toBe(sessionId)
        return { agent: await available.promise }
      },
    } as never)
    await ctx.plugin(ScheduleService)
    const delivered: { readonly id: string; readonly source: unknown }[] = []
    const enqueued = Promise.withResolvers<undefined>()
    ctx.on('agent/inbox/inserted', ({ message }) => {
      delivered.push({ id: message.id, source: message.source })
      if (message.source.kind === 'schedule') enqueued.resolve(undefined)
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const turn = Promise.withResolvers<undefined>()
    let turns = 0
    let created = false
    let laterCreated = false
    ctx.on('agent/created', async ({ agent }) => {
      available.resolve(agent)
      entered.resolve(undefined)
      await release.promise
      created = true
    })
    ctx.on('agent/created', () => { laterCreated = true })
    ctx.on('session/event', (_session, event) => { if (event.type === 'turn/start') { turns += 1; turn.resolve(undefined) } })
    const creating = ctx.agents.create({ sessionId })
    try {
      await entered.promise
      await enqueued.promise
      // A full event-loop turn lets the due runtime run if it starts during creation.
      await setImmediate()
      expect(delivered).toHaveLength(1)
      expect(delivered[0]?.source).toMatchObject({ kind: 'schedule' })
      expect(turns).toBe(0)
      expect(laterCreated).toBe(false)
      release.resolve(undefined)
      await creating
      await turn.promise
      expect(created).toBe(true)
      expect(laterCreated).toBe(true)
      // The receipt commits after the flush resolves, so the settled record is observed asynchronously.
      await expect.poll(async () => (await ctx.schedule.catalog())[0]?.status).toBe('inactive')
      const [entry] = await ctx.schedule.catalog()
      expect(entry?.lastDelivery?.messageId).toBe(delivered[0]?.id)
    } finally {
      release.resolve(undefined)
      await creating
      await ctx.fiber.dispose()
    }
  })
})
