import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@panedesk/cordis'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import { LlmError } from '@panedesk/dsh-llm'
import SubagentRuntime from '../src/index.ts'
import { checkDeliveries, prepareDeliveries, writeErrorArtifacts } from '../src/delivery.ts'
import { awaitChildWork } from '../src/lifecycle.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations, startPreparedActivation } from './local-activation.ts'
import { MemoryLedger, seedParentLedger } from './ledger-fixture.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup(script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('done')]) {
  const root = await mkdtemp(join(tmpdir(), 'subagent-delivery-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MemoryLedger)
  const ledger = ctx.sessionLedger as MemoryLedger
  await seedParentLedger(ledger)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('parent'), meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'model-a' } })
  const parent = handle.agent
  const request = { parent, prompt: [{ type: 'text' as const, text: 'task' }], signal: new AbortController().signal }
  return { ctx, root, ledger, parent, request }
}

describe('declared delivery settlement', () => {
  it.runIf(process.platform === 'linux')('confirms the host identity for an in-process child', async () => {
    const { ledger, request } = await setup()
    const run = await startPreparedActivation(request)
    await run.result
    const child = ledger.starts.find(start => start.parentSessionId === request.parent.id)!
    expect(child.processIdentity).toMatchObject({ pid: process.pid, verification: 'verified' })
    expect(child.processIdentity?.startIdentity).toBeTypeOf('string')
    expect(child.processIdentity?.bootIdentity).toBeTypeOf('string')
    expect(ledger.events).toContainEqual(expect.objectContaining({ kind: 'process/observed', runId: child.runId, liveness: 'confirmed' }))
  })

  it('settles a failed process observation before refusing child publication', async () => {
    const { ledger, request, ctx } = await setup()
    const append = ledger.appendEvent.bind(ledger)
    vi.spyOn(ledger, 'appendEvent').mockImplementation(async (event) => {
      if (event.kind === 'process/observed') throw new Error('Process observation failed')
      return append(event)
    })
    await expect(startPreparedActivation(request)).rejects.toThrow('Process observation failed')
    const child = ledger.starts.find(start => start.parentSessionId === request.parent.id)!
    expect(ledger.finishes).toContainEqual(expect.objectContaining({ runId: child.runId, endReason: 'error' }))
    expect(ledger.contextFor(child.sessionId)).toBeUndefined()
    expect(ctx.agents.get(child.sessionId)).toBeUndefined()
  })

  it('classifies a structured runtime timeout without changing the public stop reason', async () => {
    const { ledger, request } = await setup([() => { throw new LlmError('Request idle deadline exceeded', 'TIMEOUT') }])
    const run = await startPreparedActivation(request)
    expect((await run.result).stopReason).toBe('error')
    expect(ledger.finishes[0]).toMatchObject({ endReason: 'timeout', upstreamStopReason: 'TIMEOUT: Request idle deadline exceeded' })
  })

  it('records missing output separately from execution success', async () => {
    const { ledger, request } = await setup()
    const run = await startPreparedActivation({ ...request, deliveryPaths: ['result.txt'] })
    expect(await run.result).toMatchObject({ stopReason: 'completed', deliveryState: 'missing' })
    expect(ledger.finishes[0]).toMatchObject({ endReason: 'completed', deliveryState: 'missing' })
    expect(ledger.events.some(event => event.kind === 'delivery' && event.state === 'missing')).toBe(true)
  })

  it('keeps a partial delivery and existing error sidecar while writing a suffixed runtime error', async () => {
    const { root, ledger, request } = await setup([() => { throw new Error('Provider failed before completion') }])
    await writeFile(join(root, 'result.txt'), 'partial draft')
    await writeFile(join(root, 'result.txt.err.txt'), 'earlier failure')
    const run = await startPreparedActivation({ ...request, deliveryPaths: ['result.txt'] })
    expect((await run.result).stopReason).toBe('error')
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('partial draft')
    expect(await readFile(join(root, 'result.txt.err.txt'), 'utf8')).toBe('earlier failure')
    const artifact = ledger.finishes[0]?.errorArtifact
    expect(artifact).toContain('.err.')
    expect(await readFile(artifact!, 'utf8')).toContain('Provider failed before completion')
  })

  it('rejects lexical and symlink workspace escapes before execution', async () => {
    const { ctx, root, parent, request } = await setup()
    await expect(startPreparedActivation({ ...request, deliveryPaths: ['../escape.txt'] })).rejects.toMatchObject({ code: 'DELIVERY_OUTSIDE_WORKSPACE' })
    const outside = await mkdtemp(join(tmpdir(), 'subagent-outside-'))
    roots.push(outside)
    await symlink(outside, join(root, 'link'))
    await expect(prepareDeliveries(ctx, parent, ['link/result.txt'])).rejects.toMatchObject({ code: 'DELIVERY_OUTSIDE_WORKSPACE' })
  })

  it('distinguishes an uncheckable file and never overwrites declared sidecar-shaped outputs', async () => {
    const { ctx, parent } = await setup()
    const plan = await prepareDeliveries(ctx, parent, ['result.txt', 'result.txt.err.txt'])
    const stat = vi.spyOn(ctx.fs, 'stat').mockRejectedValueOnce(new Error('Observation unavailable'))
    expect((await checkDeliveries(plan)).state).toBe('uncheckable')
    stat.mockRestore()
    await expect(writeErrorArtifacts(plan!, 'run-a', 'failure')).rejects.toMatchObject({ code: 'DELIVERY_ARTIFACT_COLLISION' })
  })

  it('records a paired interval for the actual parked child join', async () => {
    const { ctx, parent, ledger } = await setup()
    const gate = Promise.withResolvers<undefined>()
    const waiting = awaitChildWork(ctx, parent, [gate.promise])
    await Promise.resolve()
    expect(ledger.events.some(event => event.kind === 'wait/end')).toBe(false)
    gate.resolve(undefined)
    await waiting
    const events = ledger.events.filter(event => event.kind === 'wait/start' || event.kind === 'wait/end')
    expect(events.map(event => event.kind)).toEqual(['wait/start', 'wait/end'])
    expect(events[1]).toMatchObject({ interval: { kind: 'subagent', durationMs: expect.any(Number) as number } })
  })

  it('awaits lifecycle listeners without changing contained notification isolation', async () => {
    const { ctx, ledger, request } = await setup()
    const edges: string[] = []
    ctx.on('subagent/before-start', async () => { await Promise.resolve(); edges.push('before') })
    ctx.on('subagent/start', () => { edges.push('start'); throw new Error('Contained observer failure') })
    ctx.on('subagent/after-settle', async () => { await Promise.resolve(); edges.push('after') })
    const run = await startPreparedActivation(request)
    await run.result
    expect(edges).toEqual(['before', 'start', 'after'])
    expect(ledger.finishes).toHaveLength(1)
  })
})
