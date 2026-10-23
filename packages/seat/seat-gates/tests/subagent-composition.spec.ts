/** Dispatch and return policies run through a Loader-mounted real subagent manager. */
import { expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GateDefinition } from '@panedesk/dsh-seat'
import { SessionId } from '@panedesk/dsh-session'
import { localHost } from './local-host.ts'
import { operation } from '../../seat-local/tests/fixtures.ts'

it('denies three real dispatches until expiry and observes one child return without blocking settlement', async () => {
  const expires = Date.now() + 60000
  const gate = (id: string, hook: GateDefinition['hook'], parameters: GateDefinition['criterion']['parameters']): GateDefinition => ({
    id: id as GateDefinition['id'], name: id, hook, criterion: { type: id as GateDefinition['criterion']['type'], parameters },
    alternative: 'Review the task details.', expiresAt: hook === 'before-subagent-dispatch' ? new Date(expires).toISOString() : null,
    enabled: true, revision: 1, order: 1,
  })
  const clock = vi.spyOn(Date, 'now')
  const f = await localHost(undefined, { definitions: [
    gate('required-fields', 'before-subagent-dispatch', { required: ['approval'] }),
    gate('report-first-line', 'after-subagent-return', { prefix: 'Result:' }),
  ] }, true)
  try {
    const sourcePath = join(f.root, 'seats.csv')
    await writeFile(sourcePath, 'seat,model\nseat-a,model-a\n')
    const plan = await f.seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: { subagentContextThresholdTokens: 30 } })
    if ('status' in plan) throw new Error(JSON.stringify(plan))
    await f.seats.commitImport({ planId: plan.planId, selectedRows: plan.rows.map(row => row.row), expectedRevision: 0, operationId: operation('import') })
    const opened = await f.seats.open({ seat: f.defaults.seat, origin: 'manual', operationId: operation('parent'), openingMode: 'prefill' })
    if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
    const parent = f.ctx.agents.get(opened.sessionId)!
    const start = () => f.ctx.subagents.startActivation({ provider: 'spawn', label: 'child task', delivery: 'caller',
      request: { parent, prompt: [{ type: 'text', text: 'Return the result.' }] }, signal: new AbortController().signal })
    for (let attempt = 0; attempt < 3; attempt++) await expect(start()).rejects.toThrow('Missing dispatch fields: approval')
    expect(f.model.requests).toHaveLength(0)
    expect((await f.ctx.get('seatGates')!.list({ limit: 20 })).gates.find(row => row.definition.id === 'required-fields'))
      .toMatchObject({ hitCount: 3, expired: false })
    clock.mockReturnValue(expires + 1)
    const activation = await start()
    expect(await activation.result).toMatchObject({ stopReason: 'completed', output: [{ type: 'text', text: 'Opening received.' }] })
    const rows = (await f.ctx.get('seatGates')!.list({ limit: 20 })).gates
    expect(rows.find(row => row.definition.id === 'required-fields')).toMatchObject({ hitCount: 3, expired: true })
    expect(rows.find(row => row.definition.id === 'report-first-line')).toMatchObject({ hitCount: 1 })
    const history = await f.ctx.get('seatEngine')!.query({ kinds: ['gate/hit', 'gate/expired'], limit: 100 })
    expect(history.effects.filter(effect => effect.kind === 'gate/expired')).toHaveLength(1)
    expect(history.effects.filter(effect => effect.kind === 'gate/hit' && effect.data.context.hook === 'after-subagent-return'))
      .toMatchObject([{ data: { result: { outcome: 'observe' }, context: { childSessionId: activation.childId } } }])
    const childLedger = await f.ctx.sessionLedger.query({ sessionId: activation.childId })
    expect(childLedger.complete, JSON.stringify(childLedger)).toBe(true)
    expect(childLedger.rows.some(row => row.kind === 'call' && row.finish?.usage?.inputTokens === 10), JSON.stringify(childLedger)).toBe(true)
    expect(await f.seats.resolve(f.defaults.seat)).toMatchObject({ subagentContextThresholdTokens: 30 })
    await expect(f.ctx.subagents.sendMessage(parent, activation.childId, [{ type: 'text', text: 'Continue.' }],
      { signal: new AbortController().signal })).rejects.toThrow('subagent-context-limit')
    await expect(f.ctx.subagents.sendMessage(parent, SessionId('unavailable-child'), [{ type: 'text', text: 'Continue.' }],
      { signal: new AbortController().signal })).rejects.toThrow('evidence-unavailable')
    await f.unmount()
    expect(f.ctx.get('subagentDispatch')).toBeUndefined()
  } finally { clock.mockRestore(); await f.close() }
}, 30000)
