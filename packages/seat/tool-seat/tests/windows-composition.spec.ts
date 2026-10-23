/** Model window tools run through the Loader, local provider and durable engine. */
import { expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import type { Agent } from '@panedesk/dsh-agent'
import type { GateDefinition } from '@panedesk/dsh-seat'
import { CreationAdapter } from '../../seat-local/tests/creation-provider.ts'
import { operation } from '../../seat-local/tests/fixtures.ts'
import { localHost } from '../../seat-gates/tests/local-host.ts'
import { completesIdleTurn, completesTurn, inputContains } from '../../seat/tests/completion.ts'

class WindowModel extends CreationAdapter {
  caller?: SessionId
  call?: { name: string; arguments: object }
  count = 0
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  hold = false
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== this.caller && this.hold) {
      this.entered.resolve(undefined)
      await this.release.promise
    }
    const call = options.sessionId === this.caller ? this.call : undefined
    if (!call) { yield* super.stream(options); return }
    this.call = undefined
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`window-${++this.count}`),
      name: call.name, arguments: JSON.stringify(call.arguments) } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

type Host = Awaited<ReturnType<typeof localHost>>
async function caller(f: Host, model: WindowModel): Promise<Agent> {
  const cwd = join(f.root, 'caller')
  await mkdir(cwd)
  const { agent } = await f.ctx.agents.create({ sessionId: SessionId('session-a'), meta: { cwd },
    agentOptions: { provider: 'provider-a', model: 'model-a' } })
  model.caller = agent.id
  return agent
}
async function importSeat(f: Host): Promise<void> {
  const sourcePath = join(f.root, 'seats.csv')
  await writeFile(sourcePath, 'seat,model\nseat-a,model-a\n')
  const plan = await f.seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} })
  if ('status' in plan) throw new Error(JSON.stringify(plan))
  expect(await f.seats.commitImport({ planId: plan.planId, selectedRows: plan.rows.map(row => row.row),
    expectedRevision: 0, operationId: operation('import') })).toMatchObject({ status: 'committed' })
}
async function invoke(f: Host, model: WindowModel, agent: Agent, name: string, args: object) {
  model.call = { name, arguments: args }
  const text = `Invoke ${name} ${model.count + 1}.`
  await completesTurn(f.ctx, agent.id, inputContains(text), async () => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  })
  await f.ctx.sessions.flush(agent.session)
  const events = (await f.ctx.sessionQuery.readSession(agent.id)).events
  const result = events.findLast(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Missing tool result')
  return JSON.stringify(result.data)
}

it('opens an explicitly named seat with invocation authority and retains capacity, busy and external guards', async () => {
  const model = new WindowModel()
  const f = await localHost(model)
  try {
    const agent = await caller(f, model)
    await importSeat(f)
    model.hold = true
    const authority = vi.spyOn(f.ctx.get('seats')!, 'withAuthority')
    const opened = await invoke(f, model, agent, 'seat_open', { seat: 'seat-a' })
    expect(opened).toContain('opened')
    expect(opened).not.toContain('Verified authority is required')
    await model.entered.promise
    expect(authority.mock.calls.map(([value]) => value)).toContainEqual({
      kind: 'model-tool-call', sessionId: agent.id, callId: 'window-1',
      principalId: `model-tool-call:${agent.id}:window-1`, origin: 'manual', nodeId: await f.ctx.sessionLedger.nodeId(),
    })
    const facts = await f.ctx.get('seatEngine')!.query({ limit: 1000 })
    const accepted = facts.effects.find(effect => effect.kind === 'trigger/accepted')
    if (accepted?.kind !== 'trigger/accepted') throw new Error('Missing opening source')
    expect(accepted.data.trigger.evidence).toEqual({ kind: 'manual', origin: 'manual', operationId: `tool:${agent.id}:window-1` })
    const windows = await f.ctx.get('seatLocalRead')!.list({})
    if (windows.status !== 'listed' || !windows.sessions[0]) throw new Error(JSON.stringify(windows))
    const target = windows.sessions[0]
    expect(target.seat).toBe('seat-a')
    expect(target.busyReasons).toContainEqual({ kind: 'turn', summary: 'A turn is running.' })
    expect(await invoke(f, model, agent, 'seat_open', { seat: 'seat-a' })).toContain('choice-required')
    const busy = await invoke(f, model, agent, 'seat_close', { sessionId: target.sessionId, expectedStateVersion: target.stateVersion })
    expect(busy).toContain('busy')
    expect(busy).toContain('A turn is running.')
    expect(await invoke(f, model, agent, 'seat_close', { sessionId: target.sessionId, expectedStateVersion: -1 })).toContain('conflict')
    await expect(f.ctx.get('seats')!.open({ seat: f.defaults.seat, origin: 'manual', operationId: operation('external') }))
      .rejects.toThrow('Verified authority is required.')
    expect((await f.ctx.get('seatEngine')!.query({ limit: 1000 })).effects.filter(effect => effect.kind === 'open/created')).toHaveLength(1)
    await completesIdleTurn(f.ctx, f.ctx.agents.get(target.sessionId)!, () => { model.release.resolve(undefined) })
    const access = f.ctx.get('seatLocalWindows')!.forInvocation({ session: agent.session, callId: ToolCallId('retained-call') })
    expect(Object.keys(access).sort()).toEqual(['close', 'open', 'rename', 'renew', 'replace', 'wake'])
    await f.unmount()
    expect(f.ctx.get('seatLocalWindows')).toBeUndefined()
    await expect(access.rename({ sessionId: target.sessionId, title: 'window-a', operationId: operation('stale') }))
      .rejects.toThrow('Only the calling live session may invoke window tools.')
  } finally { model.release.resolve(undefined); await f.close() }
}, 30000)

it('keeps before-open gate denials observable without creating a window', async () => {
  const model = new WindowModel()
  const gate: GateDefinition = { id: 'gate-a' as GateDefinition['id'], name: 'Opening admission', hook: 'before-open',
    criterion: { type: 'criterion-a' as GateDefinition['criterion']['type'], parameters: {} }, alternative: 'Resolve opening admission.',
    expiresAt: null, enabled: true, revision: 1, order: -1 }
  const f = await localHost(model, { definitions: [gate] })
  const off = f.ctx.get('seatGates')!.register({ id: gate.criterion.type, async evaluate(context) {
    if (context.seat === null) return { gateId: gate.id, revision: 1, hitCount: 0, expiresAt: null, audit: 'recorded', outcome: 'allow' }
    return { gateId: gate.id, revision: 1, hitCount: 0, expiresAt: null, audit: 'recorded', outcome: 'deny',
      reason: { code: 'gate-denied', message: 'Opening admission denied.', alternative: gate.alternative,
        retryable: false, effectState: 'none' }, alternative: gate.alternative }
  } })
  try {
    const agent = await caller(f, model)
    await importSeat(f)
    const result = await invoke(f, model, agent, 'seat_open', { seat: 'seat-a' })
    expect(result).toContain('Opening admission denied.')
    const facts = await f.ctx.get('seatEngine')!.query({ limit: 1000 })
    expect(facts.effects.some(effect => effect.kind === 'open/created')).toBe(false)
    expect(facts.effects).toContainEqual(expect.objectContaining({ kind: 'gate/hit', operationId: `tool:${agent.id}:window-1` }))
  } finally { off(); await f.close() }
}, 30000)
