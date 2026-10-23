/** Turn-owned audit and clock state is released on settlement and plugin disposal. */
import type { Context } from '@panedesk/cordis'
import type { EngineEffect, SeatEngineService } from '@panedesk/dsh-seat'
import type { Config } from './index.ts'
import { canonicalWritePath } from './memory.ts'
import { compareMemory, snapshotMemory, type MemorySnapshot } from './memory-audit.ts'
import { SeatClock } from './clock.ts'

/** Install awaited start/stop evidence and logged timestamp contributions.
 * @param ctx - reversible plugin owner with optional seat providers.
 * @param config - complete snapshot bounds and display zone.
 */
export function installLifecycle(ctx: Context, config: Config): void {
  const clock = new SeatClock(Date.now, config.timeZone)
  const turns = new Map<string, { key: string; roots: string[]; before: MemorySnapshot }>()
  const pending = new Set<Promise<void>>()
  ctx.on('agent/input-preparing', async ({ agent, turn }) => {
    if (turns.has(agent.session.id)) return
    const seats = ctx.get('seats')
    if (!seats) return
    const roots: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await seats.definitions(cursor === undefined ? {} : { cursor })
      for (const definition of page.definitions) {
        for (const root of definition.memoryDirectories) roots.push(await canonicalWritePath(root, '/'))
      }
      if (page.complete) break
      if (page.nextCursor === undefined || page.nextCursor === cursor) throw new Error('Memory audit catalog is incomplete.')
      cursor = page.nextCursor
    }
    const before = await snapshotMemory(roots, config.memoryAuditMaxBytes, config.memoryAuditMaxFiles)
    turns.set(agent.session.id, { key: `${agent.session.id}:${turn}`, roots, before })
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!exec.agent || decision.kind !== 'accept' || 'value' in decision) return decision
    const turn = turns.get(exec.agent.session.id)
    if (!turn) return decision
    const stamp = clock.stamp(turn.key)
    if (stamp === null) return decision
    return { ...decision, content: [...decision.content ?? result.content,
      { type: 'text', text: `Clock data: ${stamp}` }] }
  })
  const finish = async (sessionId: import('@panedesk/dsh-session').SessionId) => {
    const turn = turns.get(sessionId)
    if (!turn) return
    turns.delete(sessionId)
    clock.release(turn.key)
    const after = await snapshotMemory(turn.roots, config.memoryAuditMaxBytes, config.memoryAuditMaxFiles)
    const data = compareMemory(sessionId, turn.before, after)
    if (data.paths.length === 0 && data.complete) return
    const engine = ctx.get('seatEngine')
    if (!engine) throw new Error('Memory audit store is unavailable.')
    await appendAudit(engine, { eventId: `memory:${turn.key}` as EngineEffect['eventId'], kind: 'memory/audit', data })
  }
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const task = finish(session.id)
    pending.add(task)
    // Keep failure observable to the next awaited flush without an unhandled rejection.
    void task.catch(() => {})
  })
  ctx.on('session/flush', async () => {
    const tasks = [...pending]
    await Promise.all(tasks)
    for (const task of tasks) pending.delete(task)
  })
  ctx.on('agent/ending', async ({ agent }) => { await finish(agent.session.id) })
  ctx.effect(() => async () => {
    await Promise.all(pending)
    for (const turn of turns.values()) clock.release(turn.key)
    turns.clear()
  })
}

async function appendAudit(engine: SeatEngineService, effect: EngineEffect): Promise<void> {
  for (;;) {
    const page = await engine.query({ kinds: ['memory/audit'], limit: 1 })
    const result = await engine.appendEffects({ decisionId: String(effect.eventId) as import('@panedesk/dsh-seat').EngineDecisionId,
      expectedSequence: page.watermark, observedAt: new Date().toISOString(), policyRevision: 1, effects: [effect] })
    if (result.status === 'conflict') continue
    if (result.status === 'rejected') throw new Error('Memory audit publication failed.')
    return
  }
}
