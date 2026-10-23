/** A replacement expires its one-use permit before closing either window. */
import type { EngineReplacementData, HandoverPermit, ReplaceSeatRequest, ReplaceSeatResult, SeatFailure } from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'

/** Engine admission counts both windows and leaves exclusive tags on the old owner. */
export interface ReplacementRuntime {
  admit(request: ReplaceSeatRequest): Promise<ReplaceSeatResult | EngineReplacementData>
  openNew(transaction: EngineReplacementData): Promise<EngineReplacementData>
  firstTurn(transaction: EngineReplacementData): Promise<NonNullable<EngineReplacementData['firstTurn']>>
  persist(transaction: EngineReplacementData): Promise<void>
  close(sessionId: SessionId, reason: 'replaced' | 'replacement-failed'): Promise<'closed' | 'busy'>
  transferTags(transaction: EngineReplacementData): Promise<void>
  failed(transaction: EngineReplacementData, cleanup: 'not-created' | 'closed' | 'pending'): Promise<void>
  now(): string
}

/** Continue one persisted replacement without treating an unrelated reply as opening success.
 * @param runtime - admission, persisted observations and upstream close capabilities.
 * @param request - stable old-window operation.
 * @returns FIFO pending, replacement progress or cleanup-aware failure.
 */
export async function replaceWindow(runtime: ReplacementRuntime, request: ReplaceSeatRequest): Promise<ReplaceSeatResult> {
  let transaction = await runtime.admit(request)
  if ('status' in transaction) return transaction
  if (transaction.phase === 'completed' && transaction.permit !== null && transaction.newSessionId !== null) {
    return { status: 'replacing', replacementId: transaction.replacementId, oldSessionId: transaction.oldSessionId,
      newSessionId: transaction.newSessionId, phase: 'completed', permit: transaction.permit }
  }
  if (transaction.phase === 'closing-new' || transaction.phase === 'failed' || transaction.permit?.state === 'expired-failure') {
    if (transaction.failure === null) throw new Error('Failed replacement has no durable cause')
    return cleanupReplacement(runtime, transaction, transaction.failure)
  }
  let reason: 'replacement-open-failed' | 'replacement-first-turn-failed' = 'replacement-open-failed'
  try {
    if (transaction.phase === 'opening' || transaction.newSessionId === null) transaction = await runtime.openNew(transaction)
    reason = 'replacement-first-turn-failed'
    if (transaction.permit === null || transaction.newSessionId === null) throw new Error('Replacement admission has no new-window permit')
    if (transaction.permit.state !== 'expired-success') {
      const firstTurn = await runtime.firstTurn(transaction)
      if (firstTurn.messageId !== transaction.openingMessageId || !firstTurn.completed || !firstTurn.hasAssistantReply) {
        throw new Error('The opening turn did not complete with an assistant reply')
      }
      transaction = { ...transaction, firstTurn, phase: 'awaiting-old-idle',
        permit: { ...transaction.permit, state: 'expired-success', expiredAt: runtime.now() } }
      await runtime.persist(transaction)
    }
  } catch (error) {
    const cause: SeatFailure = { code: reason, message: error instanceof Error ? error.message : 'Replacement failed.',
      alternative: 'Inspect the failed new window before retrying replacement.', retryable: false, effectState: 'partial' }
    transaction = { ...transaction, phase: 'closing-new', failure: cause,
      permit: transaction.permit === null ? null : { ...transaction.permit, state: 'expired-failure', expiredAt: runtime.now() } }
    await runtime.persist(transaction)
    return cleanupReplacement(runtime, transaction, cause)
  }
  // Old-window close failures retain a successful new window; they are not opening failures.
  const permit = transaction.permit as HandoverPermit
  const newSessionId = transaction.newSessionId as SessionId
  if (await runtime.close(transaction.oldSessionId, 'replaced') === 'busy') {
    return { status: 'replacing', replacementId: transaction.replacementId, oldSessionId: transaction.oldSessionId,
      newSessionId, phase: 'awaiting-old-idle', permit }
  }
  transaction = { ...transaction, phase: 'closing-old' }
  await runtime.persist(transaction)
  await runtime.transferTags(transaction)
  transaction = { ...transaction, phase: 'completed' }
  await runtime.persist(transaction)
  return { status: 'replacing', replacementId: transaction.replacementId, oldSessionId: transaction.oldSessionId,
    newSessionId, phase: 'completed', permit }
}

async function cleanupReplacement(runtime: ReplacementRuntime, transaction: EngineReplacementData,
  cause: SeatFailure): Promise<ReplaceSeatResult> {
  let cleanup: 'not-created' | 'closed' | 'pending' = transaction.newSessionId === null ? 'not-created' : 'closed'
  if (transaction.phase !== 'failed' && transaction.newSessionId !== null) {
    try { cleanup = await runtime.close(transaction.newSessionId, 'replacement-failed') === 'closed' ? 'closed' : 'pending' }
    catch (cleanupError) { void cleanupError; cleanup = 'pending' }
  }
  if (transaction.phase !== 'failed') {
    await runtime.failed({ ...transaction, phase: cleanup === 'pending' ? 'closing-new' : 'failed' }, cleanup)
  }
  return { status: 'failed', replacementId: transaction.replacementId, oldSessionId: transaction.oldSessionId,
    newSessionId: transaction.newSessionId, phase: 'failed',
    reason: cause.code === 'replacement-open-failed' ? 'replacement-open-failed' : 'replacement-first-turn-failed', cause, cleanup }
}
