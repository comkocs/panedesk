import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import type { CloseReportId, CloseSelfReport } from '@panedesk/dsh-seat'
import { CloseCoordinator, type ReportRuntime } from '../src/report.ts'
import { ContextUsageObserver, type ContextReminderDelivery } from '../src/context-usage.ts'

const sessionId = 'session-a' as SessionId
const report: CloseSelfReport = { sessionId, reportId: 'report-a' as CloseReportId, canClose: true,
  waitingFor: [], nextOpen: { when: { kind: 'unspecified' }, prerequisites: ['Review results.'] },
  submittedAt: '2026-01-01T00:00:00.000Z', stateVersion: 1 }
const idle = { complete: true, running: false, approvals: [], planReviews: [], answers: [], subagents: [], jobs: [], waits: [], tickets: [], inbox: [],
  lastConsumedTurn: null, droppedUnrun: false, lastActivityAt: null, stateVersion: 1 }

describe('self-report and context reminders', () => {
  it('reminds instead of closing while child work remains and closes with the latest three report fields once idle', async () => {
    const runtime: ReportRuntime = { latest: vi.fn(async () => report), evidence: vi.fn(async () => ({ ...idle, subagents: ['child-a'] })),
      remind: vi.fn(async () => {}), closeIfCurrent: vi.fn(async () => ({ status: 'closed', sessionId, phase: 'closed', endedAt: report.submittedAt, stateVersion: 2 })) }
    const coordinator = new CloseCoordinator(runtime)
    expect(await coordinator.evaluate(sessionId)).toMatchObject({ status: 'busy' })
    expect(runtime.closeIfCurrent).not.toHaveBeenCalled()
    expect(runtime.remind).toHaveBeenCalledWith(sessionId, 'report-a:busy', expect.stringContaining('child-a'), 'steer')
    vi.mocked(runtime.evidence).mockResolvedValue(idle)
    expect(await coordinator.evaluate(sessionId)).toMatchObject({ status: 'closed' })
    expect(runtime.closeIfCurrent).toHaveBeenCalledWith(report, 1)
    vi.mocked(runtime.latest).mockResolvedValue({ ...report, canClose: false, stateVersion: 2 })
    expect(await coordinator.evaluate(sessionId)).toBeNull()
    expect(runtime.closeIfCurrent).toHaveBeenCalledTimes(1)
  })

  it('delivers threshold reminders as handoff steer once per revision and compaction epoch without replacing windows', async () => {
    const send = vi.fn<ContextReminderDelivery['send']>(async () => {})
    const observer = new ContextUsageObserver({ send })
    observer.sample(sessionId, { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 100 }, report.submittedAt)
    expect(await observer.remind(sessionId, 400, 1, false)).toBe(true)
    expect(await observer.remind(sessionId, 400, 1, false)).toBe(false)
    expect(send).toHaveBeenCalledWith({ sessionId, operationId: 'session-a:context:1:0', messageClass: 'handoff', mode: 'steer',
      text: 'Context threshold reached. Consider replacing this window after reporting its pending work.' })
    observer.compacted(sessionId, 20, report.submittedAt)
    expect(await observer.remind(sessionId, 400, 1, false)).toBe(false)
    observer.sample(sessionId, { inputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 }, report.submittedAt)
    expect(await observer.remind(sessionId, 400, 1, true)).toBe(true)
    expect(send.mock.calls[1]?.[0]).toMatchObject({ operationId: 'session-a:context:1:1', mode: 'steer', text: expect.stringContaining('new agent') })
    expect(await observer.remind(sessionId, undefined, 2, false)).toBe(false)
    expect(observer.sample(sessionId, { inputTokens: 400 }, report.submittedAt).status).toBe('unknown')
    expect(await observer.remind(sessionId, 400, 3, true)).toBe(false)
  })
})
