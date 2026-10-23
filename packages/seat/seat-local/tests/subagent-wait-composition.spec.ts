/** Visible child ids retain parent authorization and wake through the real Loader composition. */
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createUserMessage } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import Subagents, { SubagentRunId } from '@panedesk/dsh-subagent'
import type { RegisterSeatWaitRequest, SeatWait } from '@panedesk/dsh-seat'
import * as Spawn from '../../../subagent/subagent-spawn-in-process/src/index.ts'
import * as SubagentTool from '../../../subagent/tool-subagent/src/index.ts'
import * as SeatTool from '../../tool-seat/src/index.ts'
import { commitsEffect, completesIdleTurn, completesTurn, inputContains } from '../../seat/tests/completion.ts'
import { admissionHost } from './admission-host.ts'
import { SubagentWaitModel } from './subagent-wait-model.ts'
import { operation } from './fixtures.ts'

it('waits on the tool-visible child session, denies another parent, deduplicates replay and follows a new continuation run', async () => {
  const f = await admissionHost()
  const model = new SubagentWaitModel()
  try {
    vi.spyOn(f.adapter, 'stream').mockImplementation(options => model.stream(options))
    Object.assign(f.ctx.loader.builtins, { subagents: Subagents, spawn: Spawn, subagentTool: SubagentTool, seatTool: SeatTool })
    await f.load('subagent-wait.yml', [{ name: 'cordis:subagents' }, { name: 'cordis:spawn' },
      { name: 'cordis:subagentTool', config: { provider: 'spawn' } }, { name: 'cordis:seatTool' }])
    await f.seats.save({ definition: { ...f.definition,
      directories: [{ path: join(f.options.directory, 'owned'), startup: true }] },
    expectedRevision: 2, operationId: operation('narrow-root') })
    const createParent = async (id: string) => {
      const creation = f.ctx.get('seatLocalCreation')!
      const confirmation = await creation.confirmTraditional(f.options.directory, f.authority)
      return creation.run(confirmation, f.authority,
        () => f.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: f.options.directory },
          agentOptions: { provider: 'provider-a', model: 'model-a' } }))
    }
    const parent = await createParent('parent-a')
    model.parent = parent.agent.id
    await completesIdleTurn(f.ctx, parent.agent, () => {
      parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Delegate and wait.' }], source: { kind: 'user' } }))
    })
    await f.ctx.sessions.flush(parent.agent.session)
    const events = (await f.ctx.sessionQuery.readSession(parent.agent.id)).events
    expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)).toEqual([false, false])
    const waitId = `tool:${parent.agent.id}:delegate-1` as SeatWait['waitId']
    const wait = await f.seats.wait(waitId)
    expect(wait).toMatchObject({ phase: 'registered', objects: [{ kind: 'subagent', id: model.childId }] })
    if (!wait || !model.childId) throw new Error('The natural wait was not registered')
    expect(model.requests.filter(request => request.sessionId === parent.agent.id)).toHaveLength(2)
    const other = await createParent('parent-b')
    await f.ctx.sessions.flush(other.agent.session)
    expect(await f.seats.registerWait({ waitId: 'foreign-wait' as SeatWait['waitId'], sessionId: other.agent.id,
      objects: wait.objects, mode: 'all', operationId: operation('foreign-wait') }))
      .toMatchObject({ status: 'rejected', error: { code: 'wait-object-unauthorized' } })
    const started = (await f.state.read()).effects.find(effect => effect.kind === 'job/observed'
      && effect.data.sessionId === parent.agent.id && effect.data.phase === 'running')
    if (started?.kind !== 'job/observed') throw new Error('Missing child start')
    const runId = SubagentRunId(String(started.data.ownerEpoch))
    expect(runId).not.toBe(model.childId)
    const runWait: RegisterSeatWaitRequest = { waitId: 'run-wait' as SeatWait['waitId'], sessionId: parent.agent.id,
      mode: 'all', objects: [{ kind: 'subagent', id: runId }], operationId: operation('run-wait') }
    expect(await f.seats.registerWait(runWait)).toMatchObject({ status: 'registered', wait: { phase: 'registered' } })
    const startedAt = performance.now()
    await commitsEffect(f.ctx, effect => effect.kind === 'wait/woken' && effect.data.waitId === waitId,
      () => completesTurn(f.ctx, parent.agent.id, inputContains(`Wait ${waitId}: subagent ${model.childId}: completed`), async () => {
        model.release.resolve(undefined)
      }))
    await parent.agent.whenIdle()
    const elapsedMs = performance.now() - startedAt
    expect(elapsedMs).toBeLessThanOrEqual(5000)
    console.info(JSON.stringify({ elapsedMs, waitingModelRequests: 2 }))
    expect(await f.seats.wait(runWait.waitId)).toMatchObject({ phase: 'woken' })
    const requests = model.requests.length
    expect(await f.seats.registerWait(wait)).toMatchObject({ status: 'registered', wait: { phase: 'woken' } })
    const restored = await f.reload()
    expect(await restored.registerWait(wait)).toMatchObject({ status: 'registered', wait: { phase: 'woken' } })
    expect(model.requests).toHaveLength(requests)
    expect((await f.state.read()).effects.filter(effect => effect.kind === 'wait/woken' && effect.data.waitId === waitId)).toHaveLength(1)

    // A cold continuation retains the child session but creates a new execution epoch.
    const childId = SessionId(model.childId)
    await f.ctx.subagents.drainChildren(parent.agent, [childId])
    model.entered = Promise.withResolvers<undefined>()
    model.release = Promise.withResolvers<undefined>()
    await f.ctx.subagents.sendMessage(parent.agent, childId, [{ type: 'text', text: 'Continue the child task.' }],
      { signal: new AbortController().signal })
    await model.entered.promise
    const latest = (await f.state.read()).effects.findLast(effect => effect.kind === 'job/observed'
      && effect.data.phase === 'running' && String(effect.data.observation.object.id) === childId)
    if (latest?.kind !== 'job/observed') throw new Error('Missing continuation start')
    expect(latest.data.ownerEpoch).not.toBe(runId)
    expect(await f.runtime.snapshot({ kind: 'subagent', id: runId })).toMatchObject({ outcome: 'completed' })
    expect(await f.runtime.snapshot(wait.objects[0]!)).toBeNull()
    const continuation: RegisterSeatWaitRequest = { waitId: 'continued-wait' as SeatWait['waitId'],
      sessionId: parent.agent.id, mode: 'all', objects: wait.objects, operationId: operation('continued-wait') }
    expect(await restored.registerWait(continuation)).toMatchObject({ status: 'registered', wait: { phase: 'registered' } })
    await commitsEffect(f.ctx, effect => effect.kind === 'wait/woken' && effect.data.waitId === continuation.waitId,
      () => completesTurn(f.ctx, parent.agent.id, inputContains(`Wait continued-wait: subagent ${childId}: completed`), async () => {
        model.release.resolve(undefined)
      }))
    await parent.agent.whenIdle()
    expect(await restored.wait(continuation.waitId)).toMatchObject({ phase: 'woken',
      observations: [{ object: wait.objects[0], outcome: 'completed' }] })
    expect(await restored.wait(waitId)).toMatchObject({ phase: 'woken', stateVersion: 3 })
  } finally { model.release.resolve(undefined); await f.close() }
}, 30000)
