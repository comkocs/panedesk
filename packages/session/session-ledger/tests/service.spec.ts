import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import SessionLedger from '../src/index.ts'
import { callStart, callFinish, runStart } from './fixtures.ts'
import type { ToolDispatchExecution, ToolExecutionResult } from '@panedesk/dsh-tools'

const homes: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
async function ledger(waitTools = {}) {
  const home = await mkdtemp(join(import.meta.dirname, '.service-'))
  homes.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  const service = new SessionLedger(ctx, { dshHome: home, waitTools })
  return { ctx, service }
}

describe('session ledger service', () => {
  it('measures real thirty-second sleep and twenty-second child waits', async () => {
    const { ctx, service } = await ledger({ wait_sleep: 'sleep', wait_child: 'subagent' })
    await service.beginRun(runStart)
    const exec = { name: 'wait_sleep', callId: 'real-sleep', agent: { session: { id: runStart.sessionId } } } as ToolDispatchExecution
    await Promise.all([
      ctx.waterfall('tools/execute', exec, async () => { await setTimeout(30_000); return {} as ToolExecutionResult }),
      ctx.waterfall('tools/execute', { ...exec, name: 'wait_child', callId: 'real-child' as typeof exec.callId }, async () => {
        await setTimeout(20_000)
        return {} as ToolExecutionResult
      }),
    ])
    const snapshot = await service.snapshot()
    for (const [kind, expected] of [['sleep', 30_000], ['subagent', 20_000]] as const) {
      const matches = snapshot.rows.filter(row => row.kind === 'event' && row.event.kind === 'wait/end' && row.event.interval.kind === kind)
      expect(matches).toHaveLength(1)
      const row = matches[0]
      if (!row || row.kind !== 'event' || row.event.kind !== 'wait/end') throw new Error('Missing measured interval')
      expect(Math.abs((row.event.interval.durationMs ?? 0) - expected)).toBeLessThanOrEqual(1000)
    }
  }, 35_000)
  it('persists calls and closes runs with first-terminal-wins compare-and-set', async () => {
    const { service } = await ledger()
    const nodeId = await service.nodeId()
    await service.beginCall({ ...callStart, nodeId })
    await service.finishCall(callFinish)
    await service.beginRun({ ...runStart, nodeId })
    const finish = { runId: runStart.runId, observedAt: 300, endReason: 'completed' as const, recovered: false, deliveryState: 'not-requested' as const }
    const results = await Promise.all([service.finishRun(finish), service.finishRun({ ...finish, endReason: 'killed', recovered: true })])
    expect(results.map(result => result.kind).sort()).toEqual(['appended', 'existing'])
    const snapshot = await service.query({ sessionId: callStart.sessionId })
    expect(snapshot.rows).toHaveLength(2)
    expect(snapshot.rows.find(row => row.kind === 'call')).toMatchObject({ finish: callFinish })
    const winner = results.find(result => result.kind === 'appended')
    if (!winner || winner.kind !== 'appended' || winner.event.kind !== 'run/end') throw new Error('Missing committed winner')
    expect(snapshot.rows.find(row => row.kind === 'run')).toMatchObject({ finish: winner.event.data })
    for (const result of results) {
      if (result.kind === 'conflict') throw new Error('Unexpected terminal conflict')
      expect(result.event).toEqual(winner.event)
    }
  })
  it('exposes durable sidecar append and closure through the service', async () => {
    const { service } = await ledger()
    await service.beginCall(callStart)
    const result = await service.appendArtifact({ callId: callStart.callId, kind: 'keepalive-request', seq: 0, content: '[]' })
    if (result.kind === 'conflict') throw new Error('Unexpected conflict')
    expect((await service.finishArtifact(result.reference)).kind).toBe('finished')
    await service.finishCall({ ...callFinish, artifacts: [result.reference] })
    expect((await service.snapshot()).rows[0]).toMatchObject({ finish: { artifacts: [result.reference] } })
  })
  it('owns equal wait registrations independently and rejects conflicting live categories', async () => {
    const { service } = await ledger({ wait_a: 'sleep' })
    const a = service.registerWaitTool('wait_a', 'subagent')
    const b = service.registerWaitTool('wait_a', 'subagent')
    expect(() => service.registerWaitTool('wait_a', 'sleep')).toThrow('Conflicting')
    a(); a()
    expect(() => service.registerWaitTool('wait_a', 'sleep')).toThrow('Conflicting')
    b()
    service.registerWaitTool('wait_a', 'sleep')()
  })
  it('meters configured and runtime categories around next and closes thrown dispatches', async () => {
    const { ctx, service } = await ledger({ wait_a: 'sleep' })
    await service.beginRun(runStart)
    const session = { id: runStart.sessionId }
    const exec = { name: 'wait_a', callId: 'tool-a', agent: { session } } as ToolDispatchExecution
    const result = {} as ToolExecutionResult
    await ctx.waterfall('tools/execute', exec, async () => result)
    const release = service.registerWaitTool('wait_a', 'external-marker')
    await expect(ctx.waterfall('tools/execute', { ...exec, callId: 'tool-b' as typeof exec.callId }, async () => { throw new Error('Tool failed') })).rejects.toThrow('Tool failed')
    release()
    await ctx.waterfall('tools/execute', { ...exec, name: 'unknown', callId: 'tool-c' as typeof exec.callId }, async () => result)
    const rows = (await service.snapshot()).rows.filter(row => row.kind === 'event' && row.event.kind === 'wait/end')
    expect(rows.map(row => row.kind === 'event' && row.event.kind === 'wait/end' && row.event.interval.kind).sort()).toEqual(['external-marker', 'sleep', 'unclassified'])
    for (const row of rows) if (row.kind === 'event' && row.event.kind === 'wait/end') expect(row.event.interval.durationMs).toBeGreaterThanOrEqual(0)
  })
  it('does not dispatch when a session has no durable start and delegates agentless tools', async () => {
    const { ctx } = await ledger()
    let invoked = false
    const next = async () => { invoked = true; return {} as ToolExecutionResult }
    const exec = { name: 'tool-a', callId: 'tool-a', agent: { session: { id: runStart.sessionId } } } as ToolDispatchExecution
    await expect(ctx.waterfall('tools/execute', exec, next)).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' })
    expect(invoked).toBe(false)
    await ctx.waterfall('tools/execute', { ...exec, agent: undefined }, next)
    expect(invoked).toBe(true)
  })
})
