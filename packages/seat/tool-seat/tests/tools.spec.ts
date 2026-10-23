import { describe, expect, it, vi } from 'vitest'
import type { SeatService, SeatSessionOperations, SeatWindowOperations } from '@panedesk/dsh-seat'
import { registerWaitTools } from '../src/wait.ts'
import { registerReportTools } from '../src/report.ts'
import { registerWindowTools } from '../src/windows.ts'
import * as plugin from '../src/index.ts'
import { harness } from './harness.ts'

describe('seat model tools', () => {
  it('registers waits without sleep and concludes only accepted registrations', async () => {
    const { ctx, execute } = await harness()
    const registerWait = vi.fn<SeatService['registerWait']>(async request => ({
      status: 'registered', wait: {
        ...request, phase: 'registered', stateVersion: 1, observations: [],
        wakeOperationId: request.operationId, durability: 'durable',
      },
    }))
    ctx.provide('seatLocalSession', { forSession: () => ({ registerWait } as Partial<SeatSessionOperations> as SeatSessionOperations) })
    registerWaitTools(ctx)
    try {
      const result = await execute('seat_wait', { mode: 'all', objects: [{ kind: 'subagent', id: 'child-a' }, { kind: 'job', id: 'job-a' }] })
      expect(result.isError).toBe(false)
      expect(result).toHaveProperty('concludesTurn', true)
      expect(registerWait).toHaveBeenCalledOnce()
      expect(registerWait.mock.calls[0]![0]).toMatchObject({ sessionId: 'session-a', mode: 'all', toolCallId: 'call-1', rootCallId: 'call-1', objects: [{ kind: 'subagent', id: 'child-a' }, { kind: 'job', id: 'job-a' }] })
      expect(ctx.tools.schemas().map(item => item.name)).not.toContain('sleep')
      const invalid = await execute('seat_wait', { mode: 'all', objects: [] })
      expect(invalid.isError).toBe(true)
      expect(invalid).not.toHaveProperty('concludesTurn', true)
      expect(registerWait).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
  it('preserves all three report fields and original tool attribution', async () => {
    const { ctx, execute } = await harness()
    const submitReport = vi.fn<SeatService['submitReport']>(async request => ({
      status: 'recorded', reportId: request.report.reportId, stateVersion: request.report.stateVersion,
    }))
    ctx.provide('seatLocalSession', { forSession: () => ({ submitReport } as Partial<SeatSessionOperations> as SeatSessionOperations) })
    registerReportTools(ctx)
    try {
      const fields = { canClose: true, waitingFor: [], nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] }, stateVersion: 2 }
      const result = await execute('seat_report', fields)
      expect(result.isError).toBe(false)
      expect(submitReport.mock.calls[0]![0]).toMatchObject({ report: { ...fields, sessionId: 'session-a' }, toolCallId: 'call-1', rootCallId: 'call-1' })
      expect((await execute('seat_report', { canClose: true, stateVersion: 2 })).isError).toBe(true)
      expect(submitReport).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
  it('delegates windows without hiding service refusal or manufacturing successful closure', async () => {
    const { ctx, execute } = await harness()
    const close = vi.fn<SeatService['close']>(async request => ({
      status: 'busy', sessionId: request.sessionId, busyReasons: [{ kind: 'job', objectId: 'job-a', summary: 'A job is running.' }],
    }))
    ctx.provide('seatLocalWindows', { forInvocation: () => ({ close } as Partial<SeatWindowOperations> as SeatWindowOperations) })
    registerWindowTools(ctx)
    try {
      expect((await execute('seat_close', { sessionId: 'session-b' })).isError).toBe(true)
      expect(close).not.toHaveBeenCalled()
      const result = await execute('seat_close', { sessionId: 'session-b', expectedStateVersion: 3 })
      expect(JSON.stringify(result.content)).toContain('job-a')
      expect(close).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-b', expectedStateVersion: 3 }))
    } finally { await ctx.fiber.dispose() }
  })
  it('derives all six window tools from executor identity rather than the external service', async () => {
    const { ctx, agent, execute } = await harness()
    const operations = {
      open: vi.fn(async () => ({ status: 'cancelled' as const })),
      renew: vi.fn(), replace: vi.fn(), close: vi.fn(), rename: vi.fn(), wake: vi.fn(),
    }
    const forInvocation = vi.fn((): SeatWindowOperations => operations)
    ctx.provide('seatLocalWindows', { forInvocation })
    registerWindowTools(ctx)
    try {
      for (const [index, [action, args]] of ([
        ['open', { seat: 'seat-a' }], ['renew', { sessionId: 'session-b' }],
        ['replace', { sessionId: 'session-b' }], ['close', { sessionId: 'session-b', expectedStateVersion: 3 }],
        ['rename', { sessionId: 'session-b', title: 'window-a' }], ['wake', { seat: 'seat-a', sessionId: 'session-b' }],
      ] as const).entries()) {
        await execute(`seat_${action}`, args)
        expect(forInvocation).toHaveBeenLastCalledWith({ session: agent.session, callId: `call-${index + 1}` })
        expect(operations[action]).toHaveBeenCalledWith(expect.objectContaining({ ...args,
          operationId: `tool:session-a:call-${index + 1}` }))
      }
      expect(ctx.get('seats')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
  it('contributes no tools when seat providers are absent and unloads cleanly', async () => {
    const { ctx } = await harness()
    const before = ctx.tools.schemas()
    const fiber = await ctx.plugin(plugin)
    expect(ctx.tools.schemas()).toEqual(before)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual(before)
    await ctx.fiber.dispose()
  })
})
