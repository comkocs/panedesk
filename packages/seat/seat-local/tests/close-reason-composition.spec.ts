/** Close attribution follows the latest replacement stage in the durable journal. */
import { expect, it } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import { LocalCloser } from '../src/closing-service.ts'
import { localFact } from '../src/engine-state.ts'
import { ReportStore } from '../src/report-store.ts'
import { engineFixture } from './engine-fixture.ts'
import { operation } from './fixtures.ts'

type CloseCase = {
  name: string
  phase: T.EngineReplacementData['phase']
  target: 'old' | 'new' | 'unrelated'
  selfReport: boolean
  reason: T.WindowEndReason
}
const cases: CloseCase[] = [
  { name: 'attributes a manual close of the new window after completed replacement to the caller',
    phase: 'completed', target: 'new', selfReport: false, reason: 'manual' },
  { name: 'attributes a reported close of the new window after completed replacement to its self-report',
    phase: 'completed', target: 'new', selfReport: true, reason: 'self-report' },
  { name: 'attributes closing the old window during replacement to the replacement',
    phase: 'awaiting-old-idle', target: 'old', selfReport: false, reason: 'replaced' },
  { name: 'attributes closing the new window during failed cleanup to the replacement failure',
    phase: 'closing-new', target: 'new', selfReport: false, reason: 'replacement-failed' },
  { name: 'leaves an unrelated manual close unchanged after completed replacement',
    phase: 'completed', target: 'unrelated', selfReport: false, reason: 'manual' },
  { name: 'attributes a manual close after terminal replacement failure to the caller',
    phase: 'failed', target: 'new', selfReport: false, reason: 'manual' },
  { name: 'attributes a reported close after terminal replacement failure to its self-report',
    phase: 'failed', target: 'new', selfReport: true, reason: 'self-report' },
]

it.each(cases)('$name', async ({ phase, target, selfReport, reason }) => {
  const f = await engineFixture(true)
  try {
    const opened = await f.open()
    if (opened.status !== 'opened') throw new Error('Opening did not create a window')
    const sessionId = opened.sessionId
    const oldSessionId = target === 'old' ? sessionId : 'window-a' as SessionId
    const newSessionId = target === 'new' ? sessionId : 'window-b' as SessionId
    const replacement: T.EngineReplacementData = { replacementId: 'replacement-a' as T.ReplacementId,
      oldSessionId, newSessionId, phase: 'opening', permit: null, openingMessageId: null,
      firstTurn: null, pending: null, failure: null }
    const failure: T.SeatFailure | null = phase === 'closing-new' || phase === 'failed'
      ? { code: 'replacement-first-turn-failed', message: 'Opening turn failed.', alternative: 'Inspect the window.',
        retryable: false, effectState: 'partial' } : null
    const stages: T.EngineReplacementData[] = [replacement,
      { ...replacement, phase: failure ? 'closing-new' : 'awaiting-old-idle', failure },
      { ...replacement, phase, failure }]
    await f.state.mutate(() => ({ result: undefined,
      effects: stages.map(data => localFact({ kind: 'window/replacement', data })) }))
    const report: T.CloseSelfReport | undefined = selfReport ? {
      reportId: 'report-a' as T.CloseReportId, sessionId, canClose: true, waitingFor: [],
      nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] },
      submittedAt: new Date().toISOString(), stateVersion: 1,
    } : undefined
    if (report) {
      expect(await new ReportStore(f.state).submit({ report, operationId: operation('report-a') }, {
        principalId: 'user-a' as T.SeatPrincipalId, origin: 'manual', nodeId: f.options.nodeId,
      })).toMatchObject({ status: 'recorded' })
    }
    const closer = new LocalCloser(f.ctx, f.state, f.runtime, f.options)
    expect(await closer.close({ sessionId, operationId: operation('close-a'), expectedStateVersion: 1 }, report))
      .toMatchObject({ status: 'closed', sessionId })
    await closer.drain()
    const effects = (await f.state.read()).effects
    const closed = effects.filter(effect => effect.kind === 'window/closed' && effect.data.sessionId === sessionId)
    expect(closed).toHaveLength(1)
    expect(closed[0]?.data).toMatchObject({ reason, selfReport: report ?? null,
      selfReportStatus: report ? 'submitted' : 'not-submitted' })
    const callbacks = effects.filter(effect => effect.kind === 'callback/pending'
      && effect.data.payload.kind === 'window-ended' && effect.data.payload.sessionId === sessionId)
    expect(callbacks).toHaveLength(1)
    for (const callback of callbacks) {
      expect(callback.data).toMatchObject({ payload: { kind: 'window-ended', reason,
        selfReport: report ?? null, selfReportStatus: report ? 'submitted' : 'not-submitted' } })
    }
  } finally { await f.close() }
})
