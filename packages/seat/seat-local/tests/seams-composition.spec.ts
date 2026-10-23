/** Direct ingress, failed preparation and resume use real local services and Loader. */
import { expect, it } from 'vitest'
import { join } from 'node:path'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import { createUserMessage } from '@panedesk/dsh-llm'
import * as Gates from '../../seat-gates/src/index.ts'
import { completesIdleTurn } from '../../seat/tests/completion.ts'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { renderOpening } from '../src/template.ts'
import { localFact } from '../src/engine-state.ts'

it('rejects direct engine openings before acceptance and records one policy audit', async () => {
  const f = await admissionHost()
  try {
    f.ctx.loader.builtins.gates = Gates
    const ready = Promise.withResolvers<undefined>()
    f.ctx.inject(['seatGates'], () => { ready.resolve(undefined) })
    await f.load('direct-gates.yml', [{ name: 'cordis:gates', config: { definitions: [{ id: 'opening', name: 'opening',
      hook: 'before-open', criterion: { type: 'deployment-opening', parameters: {} }, alternative: 'Cancel opening.',
      expiresAt: null, enabled: true, revision: 1, order: -1 }] } }])
    await ready.promise
    let calls = 0
    const release = f.ctx.get('seatGates')!.register({ id: 'deployment-opening' as T.GateCriterionId,
      evaluate: async (_context, definition) => {
        calls++
        return { outcome: 'deny', gateId: definition.id, revision: 1, hitCount: 0, expiresAt: null,
          audit: 'recorded', alternative: 'Cancel opening.', reason: { code: 'gate-denied', message: 'Opening blocked.',
            alternative: 'Cancel opening.', retryable: false, effectState: 'none' } }
      } })
    const before = (await f.state.read()).effects.length
    const result = await f.engine.openWindow({ request: { seat: f.definition.seat, origin: 'manual', operationId: operation('direct') },
      authority: f.authority, definition: f.definition, title: 'window-a',
      opening: renderOpening('Opening', { seat: f.definition.seat, date: '2026-01-01', taskId: null }, 4096) })
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'gate-denied', effectState: 'none' } })
    expect((await f.state.read()).effects.slice(before).map(effect => effect.kind)).toEqual(['gate/hit'])
    expect(calls).toBe(1)
    expect(f.ctx.agents.list()).toEqual([])
    expect(f.adapter.requests).toHaveLength(0)
    release()
  } finally { await f.close() }
})

it('releases unconfirmed free creation immediately when factory setup fails', async () => {
  const f = await admissionHost()
  try {
    await f.seats.save({ definition: { ...f.definition,
      directories: [{ path: join(f.options.directory, 'owned'), startup: true }] },
    expectedRevision: 2, operationId: operation('narrow-root') })
    const id = 'free-failure' as SessionId
    const calls: string[] = []
    await expect(f.ctx.agents.create({ sessionId: id, meta: { cwd: f.options.directory },
      setup: () => { expect(f.ctx.sessionLedger.contextFor(id)).toMatchObject({ seat: 'free' }); throw new Error('setup failed') },
      releasePreparation: () => { calls.push('caller') },
    })).rejects.toThrow('setup failed')
    expect(calls).toEqual(['caller'])
    expect(f.ctx.sessionLedger.contextFor(id)).toBeUndefined()
    expect(await f.seats.binding({ sessionId: id })).toBeNull()
    const retry = await f.ctx.agents.create({ sessionId: id, meta: { cwd: f.options.directory } })
    await retry.dispose()
    expect(f.ctx.sessionLedger.contextFor(id)).toBeUndefined()
  } finally { await f.close() }
})

it('restores durable seat attribution before resume publication and releases temporary ownership', async () => {
  const f = await admissionHost()
  try {
    const id = 'bound-resume' as SessionId
    const confirmation = await f.ctx.get('seatLocalCreation')!.confirmTraditional(f.options.directory, f.authority)
    const created = await f.ctx.get('seatLocalCreation')!.run(confirmation, f.authority,
      () => f.ctx.agents.create({ sessionId: id, meta: { cwd: f.options.directory } }))
    await created.dispose()
    await f.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'seat/binding', sessionId: id,
      data: { kind: 'seat', sessionId: id, nodeId: f.options.nodeId, seat: f.definition.seat,
        projectId: f.definition.projectId, bindingSource: 'seat-definition', identitySource: 'settings',
        openOperationId: operation('resume-seat'), seatRevision: 1, relatedTaskIds: [], directories: f.definition.directories,
        memoryDirectories: [], subscriptions: [], openingDigest: 'digest-a' as T.SeatDigest } })] }))
    const opened = { sessionId: id }
    await expect(f.ctx.agents.resume({ resumeSessionId: id, setup: () => { throw new Error('resume setup failed') } }))
      .rejects.toThrow('resume setup failed')
    expect(f.ctx.sessionLedger.contextFor(id)).toBeUndefined()
    f.ctx.provide('ledgerStartupIdentity', { seat: 'seat-b', window: 'window-b' })
    const prior = (await f.ctx.sessionLedger.query({ sessionId: opened.sessionId })).rows.filter(row => row.kind === 'run')
    let observed = false
    const off = f.ctx.on('agent/created', async ({ agent, source }) => {
      if (agent.id !== opened.sessionId || source !== 'resume') return
      const rows = (await f.ctx.sessionLedger.query({ sessionId: agent.id })).rows.filter(row => row.kind === 'run')
      const added = rows.filter(row => !prior.some(old => old.start.runId === row.start.runId))
      expect(added).toHaveLength(1)
      expect(added[0]?.start).toMatchObject({ seat: f.definition.seat, identitySource: 'settings' })
      observed = true
    })
    const resumed = await f.ctx.agents.resume({ resumeSessionId: opened.sessionId })
    expect(observed).toBe(true)
    off()
    await resumed.dispose()
    expect(f.ctx.sessionLedger.contextFor(opened.sessionId)).toBeUndefined()
  } finally { await f.close() }
})

it('records launch labels in the first resume residency before created and retains them durably', async () => {
  const f = await admissionHost()
  try {
    await f.seats.save({ definition: { ...f.definition,
      directories: [{ path: join(f.options.directory, 'owned'), startup: true }] },
    expectedRevision: 2, operationId: operation('narrow-root') })
    const id = 'resume-free' as SessionId
    const created = await f.ctx.agents.create({ sessionId: id, meta: { cwd: f.options.directory } })
    await created.dispose()
    f.ctx.provide('ledgerStartupIdentity', { seat: 'seat-a', window: 'window-a', taskId: 'task-a' })
    let observed = false
    const off = f.ctx.on('agent/created', async ({ agent, source }) => {
      if (agent.id !== id || source !== 'resume') return
      const runs = (await f.ctx.sessionLedger.query({ sessionId: id })).rows.filter(row => row.kind === 'run')
      expect(runs).toHaveLength(2)
      expect(runs.find(row => row.start.identitySource === 'startup')?.start)
        .toMatchObject({ seat: 'seat-a', window: 'window-a', taskId: 'task-a' })
      observed = true
    })
    const resumed = await f.ctx.agents.resume({ resumeSessionId: id })
    expect(observed).toBe(true)
    await completesIdleTurn(f.ctx, resumed.agent, () => { resumed.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Resume task' }], source: { kind: 'user' },
    })) })
    off()
    await resumed.dispose()
    expect(f.ctx.sessionLedger.contextFor(id)).toBeUndefined()
    await f.reload()
    const restored = (await f.ctx.sessionLedger.query({ sessionId: id })).rows.filter(row => row.kind === 'run')
    expect(restored.some(row => row.start.identitySource === 'startup' && row.start.window === 'window-a')).toBe(true)
  } finally { await f.close() }
})
