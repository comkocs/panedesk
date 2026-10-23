import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import type { CloseSeatRequest, CloseSeatResult } from '@panedesk/dsh-seat'
import { closeWindow, type CloseRuntime } from '../src/close.ts'
import { operation } from './fixtures.ts'
import type { WindowEvidence } from '../src/status.ts'

export function evidence(overrides: Partial<WindowEvidence> = {}): WindowEvidence {
  return { complete: true, running: false, approvals: [], planReviews: [], answers: [], subagents: [], jobs: [], waits: [], tickets: [], inbox: [],
    lastConsumedTurn: null, droppedUnrun: false, lastActivityAt: '2026-01-01T00:00:00.000Z', stateVersion: 1, ...overrides }
}
const sessionId = 'session-a' as SessionId
const request: CloseSeatRequest = { sessionId, operationId: operation('close-a'), expectedStateVersion: 1 }
export function closeFixture() {
  const steps: string[] = []
  const runtime: CloseRuntime = {
    evidence: vi.fn(async () => evidence()), begin: vi.fn(async () => { steps.push('barrier'); return null }),
    archiveSession: vi.fn(async () => { steps.push('archive') }), title: vi.fn(async () => 'window-a'),
    rename: vi.fn(async (_session, title) => { steps.push(`title:${title}`) }), flush: vi.fn(async () => { steps.push('flush') }),
    report: vi.fn(async () => null), finish: vi.fn(async (): Promise<Extract<CloseSeatResult, { status: 'closed' }>> => {
      steps.push('closed-callback'); return { status: 'closed', sessionId, phase: 'closed', endedAt: '2026-01-01T00:01:00.000Z', stateVersion: 2 }
    }), releaseBarrier: vi.fn(async () => { steps.push('release') }),
  }
  return { runtime, steps }
}

describe('safe close', () => {
  it('returns named child and job busy reasons without archive or forced stop', async () => {
    const { runtime } = closeFixture()
    vi.mocked(runtime.evidence).mockResolvedValue(evidence({ subagents: ['child-a'], jobs: ['job-a'] }))
    expect(await closeWindow(runtime, request, ' closed')).toMatchObject({ status: 'busy', busyReasons: [
      { kind: 'subagent', objectId: 'child-a' }, { kind: 'job', objectId: 'job-a' },
    ] })
    expect(runtime.archiveSession).not.toHaveBeenCalled()
    expect(runtime.begin).not.toHaveBeenCalled()
  })

  it('archives an idle window before title suffix and flush before closed callback', async () => {
    const { runtime, steps } = closeFixture()
    expect(await closeWindow(runtime, request, ' closed')).toMatchObject({ status: 'closed' })
    expect(steps).toEqual(['barrier', 'archive', 'title:window-a closed', 'flush', 'closed-callback', 'release'])
    expect(runtime.archiveSession).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(runtime.finish).toHaveBeenCalledWith(request, 'manual', null)
  })

  it('rechecks work after the barrier and releases an unused barrier', async () => {
    const { runtime } = closeFixture()
    vi.mocked(runtime.evidence).mockResolvedValueOnce(evidence()).mockResolvedValueOnce(evidence({ jobs: ['job-raced'] }))
    expect(await closeWindow(runtime, request, ' closed')).toMatchObject({ status: 'busy' })
    expect(runtime.archiveSession).not.toHaveBeenCalled()
    expect(runtime.releaseBarrier).toHaveBeenCalledOnce()
  })

  it('retains recovery barrier after archive succeeds but title fails', async () => {
    const { runtime } = closeFixture()
    vi.mocked(runtime.rename).mockRejectedValue(new Error('Title unavailable'))
    await expect(closeWindow(runtime, request, ' closed')).rejects.toThrow('Title unavailable')
    expect(runtime.finish).not.toHaveBeenCalled()
    expect(runtime.releaseBarrier).not.toHaveBeenCalled()
  })

  it('does not append a second suffix when replaying an archived closing stage', async () => {
    const { runtime } = closeFixture()
    vi.mocked(runtime.title).mockResolvedValue('window-a closed')
    expect(await closeWindow(runtime, request, ' closed')).toMatchObject({ status: 'closed' })
    expect(runtime.rename).not.toHaveBeenCalled()
  })
})
