import { describe, expect, it, vi } from 'vitest'
import type { SeatName, SeatTaskId } from '@panedesk/dsh-seat'
import { openSeat } from '../src/open.ts'
import { renderOpening } from '../src/template.ts'
import { openingFixture, sessionId } from './open-fixture.ts'
import { operation, seat } from './fixtures.ts'

const request = { seat, operationId: operation('open-a'), origin: 'remote' as const }
describe('seat opening', () => {
  it('renders seat date and task once with missing-task and escaped-delimiter handling', () => {
    const frozen = renderOpening('{{seat}} {{date}} {{taskId}} \\{{seat}}',
      { seat, date: '2026-01-01', taskId: null }, 4096)
    expect(frozen.text).toBe('seat-a 2026-01-01  {{seat}}')
    expect(renderOpening('{{taskId}}', { seat, date: '2026-01-01', taskId: '{{seat}} $&' as SeatTaskId }, 4096).text).toBe('{{seat}} $&')
    expect(() => renderOpening('{{unknown}}', frozen.variables, 4096)).toThrow('Unknown opening variable')
    expect(() => renderOpening('{{seat}}', { ...frozen.variables, seat: '' as SeatName }, 4096)).toThrow('required')
    expect(() => renderOpening('{{seat}}', frozen.variables, 2)).toThrow('byte limit')
  })

  it('uses public controlled create and publishes created callback before configuration or opening delivery', async () => {
    const { runtime, intent, steps, owners, endRun } = openingFixture()
    expect(await openSeat(runtime, request)).toMatchObject({ status: 'opened', sessionId })
    expect(runtime.controller.create.mock.calls[0]?.[0]).toMatchObject({ sessionId, cwd: process.cwd(), agentPreset: 'agent-a',
      selection: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'effort-a' } })
    expect(runtime.controller.create.mock.calls[0]?.[0].releasePreparation).toBeTypeOf('function')
    expect(steps).toEqual(['create', 'created-callback', 'workspace', 'model', 'permission', 'subscriptions', 'title', 'binding', 'release', 'send'])
    expect(runtime.sendOpening).toHaveBeenCalledExactlyOnceWith(intent)
    expect(owners).toHaveLength(1)
    expect(owners[0]).toMatchObject({ seat: 'seat-a', window: 'seat-a 01-01', identitySource: 'settings' })
    endRun()
    expect(owners).toEqual([])
  })

  it('replays the frozen opening rather than rereading changed template or host date', async () => {
    const { runtime, intent, endRun } = openingFixture()
    await openSeat(runtime, request); endRun()
    intent.definition.opening = { kind: 'text', text: 'Changed source' }
    runtime.now = () => new Date('2027-02-02T00:00:00.000Z')
    vi.mocked(runtime.exists).mockResolvedValue(true)
    await openSeat(runtime, request); endRun()
    expect(intent.opening.text).toBe('Open seat-a 2026-01-01 ')
    expect(runtime.controller.create).toHaveBeenCalledTimes(1)
    expect(runtime.sendOpening).toHaveBeenCalledTimes(1)
    expect(runtime.configure).toHaveBeenCalledTimes(6)
  })

  it('leaves no prebinding on create failure and does not reuse an ended run on resume', async () => {
    const failed = openingFixture()
    vi.mocked(failed.runtime.controller.create).mockRejectedValue(new Error('create failed'))
    expect(await openSeat(failed.runtime, request)).toMatchObject({ status: 'rejected' })
    expect(failed.owners).toEqual([])
    const fixture = openingFixture()
    await openSeat(fixture.runtime, request)
    fixture.endRun()
    expect(fixture.owners).toEqual([])
    vi.mocked(fixture.runtime.exists).mockResolvedValue(true)
    await openSeat(fixture.runtime, request)
    expect(fixture.runs).toHaveLength(2)
    expect(fixture.runs[0]?.runId).not.toBe(fixture.runs[1]?.runId)
    fixture.endRun()
    expect(fixture.owners).toEqual([])
  })

  it('prefills without delivering a model message and rejects before create when resolution fails', async () => {
    const { runtime, intent, endRun } = openingFixture()
    intent.openingMode = 'prefill'
    await openSeat(runtime, { ...request, origin: 'manual', openingMode: 'prefill' }); endRun()
    expect(runtime.sendOpening).not.toHaveBeenCalled()
    vi.mocked(runtime.resolve).mockResolvedValue({ status: 'rejected', error: { code: 'cross-node-unsupported',
      message: 'Other node.', alternative: 'Use that node.', retryable: false, effectState: 'none' } })
    expect(await openSeat(runtime, request)).toMatchObject({ error: { code: 'cross-node-unsupported' } })
    expect(runtime.controller.create).toHaveBeenCalledTimes(1)
  })
})
