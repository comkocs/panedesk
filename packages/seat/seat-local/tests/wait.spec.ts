import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import type { SeatWait, WaitId, WaitObject, WaitObservation } from '@panedesk/dsh-seat'
import { WaitCoordinator, type WaitRuntime } from '../src/wait.ts'
import { wakeWindow, type WakeRuntime } from '../src/wake.ts'
import { definition, nodeId, operation, seat } from './fixtures.ts'

const sessionId = 'session-a' as SessionId
const object: WaitObject = { kind: 'job', id: 'job-a' as Extract<WaitObject, { kind: 'job' }>['id'] }
const observation: WaitObservation = { object, outcome: 'completed', observedAt: '2026-01-01T00:00:00.000Z', watermark: 1, durability: 'durable' }

describe('event-driven waits and wake', () => {
  it('observes settlement between snapshot and subscribe and delivers one active steer wake', async () => {
    let state: SeatWait = { waitId: 'wait-a' as WaitId, sessionId, mode: 'any', objects: [object], observations: [], phase: 'registered',
      operationId: operation('wait-a'), wakeOperationId: operation('wake-a'), stateVersion: 1, durability: 'durable' }
    let settled = false
    const dispose = vi.fn(async () => {})
    const runtime: WaitRuntime = {
      authorize: async () => null, register: async () => state, read: async () => state,
      snapshot: async () => settled ? observation : null,
      subscribe: () => { settled = true; return dispose },
      observe: async (_waitId, item) => { if (state.phase === 'registered') state = { ...state, observations: [item], phase: 'satisfied', stateVersion: 2 }; return state },
      wake: vi.fn(async () => { state = { ...state, phase: 'woken', stateVersion: 3 } }),
      cancel: async () => ({ status: 'already-settled', wait: state }),
    }
    const coordinator = new WaitCoordinator(runtime)
    const result = await coordinator.register({ waitId: state.waitId, sessionId, mode: 'any', objects: [object], operationId: operation('wait-a') })
    expect(result).toMatchObject({ status: 'registered', wait: { phase: 'woken' } })
    expect(runtime.wake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ observations: [observation] }),
      { messageClass: 'handoff', mode: 'steer', text: 'Wait wait-a: job job-a: completed' })
    expect(dispose).toHaveBeenCalledOnce()
    await coordinator.dispose()
  })

  it('uses handoff to wake an active seat and delegates unopened seats to the same open function', async () => {
    const def = definition(process.cwd(), { wakeTemplate: { kind: 'text', text: 'Resume {{seat}}.' } })
    const runtime: WakeRuntime = { resolve: async () => def, candidates: vi.fn(async () => [{ sessionId, seat, nodeId, title: 'window-a' }]),
      open: vi.fn(async () => ({ status: 'cancelled' })), send: vi.fn(async request => ({ status: 'sent', sessionId, messageId: 'message-a' as Extract<import('@panedesk/dsh-seat').WakeSeatResult, { status: 'sent' | 'stored-budget-stopped' }>['messageId'], operationId: request.operationId })),
      freeze: async (_operationId, render) => render(), date: () => '2026-01-01', maxTextBytes: 4096, origin: 'manual' }
    expect(await wakeWindow(runtime, { seat, operationId: operation('wake-a') })).toMatchObject({ status: 'sent', sessionId })
    expect(runtime.send).toHaveBeenCalledWith({ sessionId, operationId: 'wake-a', text: 'Resume seat-a.', messageClass: 'handoff', mode: 'queue' })
    vi.mocked(runtime.candidates).mockResolvedValue([])
    expect(await wakeWindow(runtime, { seat, operationId: operation('wake-b') })).toEqual({ status: 'opened', result: { status: 'cancelled' } })
    expect(runtime.open).toHaveBeenCalledWith({ seat, operationId: 'wake-b', origin: 'manual', openingMode: 'auto' })
  })
})
