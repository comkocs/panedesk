import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import type { EngineReplacementData, HandoverPermitId, OwnerEpoch, ReplacementId } from '@panedesk/dsh-seat'
import { replaceWindow, type ReplacementRuntime } from '../src/replace.ts'
import { operation } from './fixtures.ts'

const oldSessionId = 'old-a' as SessionId, newSessionId = 'new-a' as SessionId
function fixture() {
  const steps: string[] = []
  const transaction: EngineReplacementData = { replacementId: 'replacement-a' as ReplacementId, oldSessionId, newSessionId,
    phase: 'opening', permit: { permitId: 'permit-a' as HandoverPermitId, replacementId: 'replacement-a' as ReplacementId,
      oldSessionId, newSessionId, state: 'issued', issuedAt: '2026-01-01T00:00:00.000Z', expiredAt: null, ownerEpoch: 'owner-a' as OwnerEpoch },
    openingMessageId: 'message-a' as EngineReplacementData['openingMessageId'], firstTurn: null, pending: null, failure: null }
  const runtime = { admit: vi.fn<ReplacementRuntime['admit']>(async () => transaction),
    openNew: vi.fn<ReplacementRuntime['openNew']>(async (value) => {
      steps.push('open-new'); return { ...value, phase: 'first-turn-pending' }
    }),
    firstTurn: vi.fn<ReplacementRuntime['firstTurn']>(async () => {
      steps.push('first-reply-completed')
      return { messageId: transaction.openingMessageId!, turnId: 'turn-a', completed: true, hasAssistantReply: true }
    }),
    persist: vi.fn<ReplacementRuntime['persist']>(async (value) => { steps.push(`persist:${value.permit?.state}:${value.phase}`) }),
    close: vi.fn<ReplacementRuntime['close']>(async (session) => { steps.push(`close:${session}`); return 'closed' }),
    transferTags: vi.fn<ReplacementRuntime['transferTags']>(async () => { steps.push('transfer-tags') }),
    failed: vi.fn<ReplacementRuntime['failed']>(async () => { steps.push('failed-callback') }), now: () => '2026-01-01T00:01:00.000Z',
  } satisfies ReplacementRuntime
  return { runtime, transaction, steps }
}

describe('replacement ordering', () => {
  it('recovers completed replacement without closing windows or transferring tags again', async () => {
    const { runtime, transaction } = fixture()
    runtime.admit.mockResolvedValue({ ...transaction, phase: 'completed' })
    expect(await replaceWindow(runtime, { sessionId: oldSessionId, operationId: operation('replace-a') }))
      .toMatchObject({ status: 'replacing', phase: 'completed' })
    expect(runtime.openNew).not.toHaveBeenCalled()
    expect(runtime.firstTurn).not.toHaveBeenCalled()
    expect(runtime.close).not.toHaveBeenCalled()
    expect(runtime.transferTags).not.toHaveBeenCalled()
  })

  it('recovers failed cleanup by closing only the new window without repeating its first turn', async () => {
    const { runtime, transaction } = fixture()
    runtime.admit.mockResolvedValue({ ...transaction, phase: 'closing-new', failure: {
      code: 'replacement-first-turn-failed', message: 'failed', alternative: 'inspect', retryable: false, effectState: 'partial',
    } })
    expect(await replaceWindow(runtime, { sessionId: oldSessionId, operationId: operation('replace-a') }))
      .toMatchObject({ status: 'failed', cleanup: 'closed' })
    expect(runtime.close).toHaveBeenCalledExactlyOnceWith(newSessionId, 'replacement-failed')
    expect(runtime.firstTurn).not.toHaveBeenCalled()
    expect(runtime.openNew).not.toHaveBeenCalled()
    expect(runtime.transferTags).not.toHaveBeenCalled()
  })

  it('expires the one-use permit after the opening reply, then closes old and transfers tags', async () => {
    const { runtime, steps } = fixture()
    expect(await replaceWindow(runtime, { sessionId: oldSessionId, operationId: operation('replace-a') })).toMatchObject({ phase: 'completed', permit: { state: 'expired-success' } })
    expect(steps).toEqual(['open-new', 'first-reply-completed', 'persist:expired-success:awaiting-old-idle',
      'close:old-a', 'persist:expired-success:closing-old', 'transfer-tags', 'persist:expired-success:completed'])
  })

  it('closes only new after opening failure and preserves the old window and tags', async () => {
    const { runtime, steps } = fixture()
    vi.mocked(runtime.openNew).mockRejectedValue(new Error('Configuration failed'))
    expect(await replaceWindow(runtime, { sessionId: oldSessionId, operationId: operation('replace-a') })).toMatchObject({ status: 'failed',
      reason: 'replacement-open-failed', cleanup: 'closed', cause: { message: 'Configuration failed' } })
    expect(runtime.close).toHaveBeenCalledExactlyOnceWith(newSessionId, 'replacement-failed')
    expect(runtime.transferTags).not.toHaveBeenCalled()
    expect(steps).toEqual(['persist:expired-failure:closing-new', 'close:new-a', 'failed-callback'])
  })

  it.each([{ completed: false, hasAssistantReply: true }, { completed: true, hasAssistantReply: false }])('does not accept an unsuccessful opening turn %j', async (fields) => {
    const { runtime, transaction } = fixture()
    vi.mocked(runtime.firstTurn).mockResolvedValue({ messageId: transaction.openingMessageId!, turnId: 'turn-a', ...fields })
    expect(await replaceWindow(runtime, { sessionId: oldSessionId, operationId: operation('replace-a') })).toMatchObject({ reason: 'replacement-first-turn-failed' })
    expect(runtime.close).toHaveBeenCalledExactlyOnceWith(newSessionId, 'replacement-failed')
  })

  it('waits for old idle after success without closing new or transferring exclusive tags', async () => {
    const { runtime } = fixture()
    vi.mocked(runtime.close).mockResolvedValue('busy')
    expect(await replaceWindow(runtime, { sessionId: oldSessionId, operationId: operation('replace-a') })).toMatchObject({ phase: 'awaiting-old-idle' })
    expect(runtime.transferTags).not.toHaveBeenCalled()
    expect(runtime.failed).not.toHaveBeenCalled()
  })
})
