/** Original action builders retain journal serialization through authorization sequence checks. */
import type * as T from '@panedesk/dsh-seat'
import { EngineError, type EngineJournal } from './journal.ts'
import type { EngineProjection } from './projection.ts'

/** A commit capability prepares original effects without executing runtime work. */
export type ActionCommit = (build: (view: EngineProjection) => readonly T.EngineEffect[]) => Promise<void>

/** Bind an original action builder to an issued grant and the real transaction provider.
 * @param journal - Existing journal owner and committed projection.
 * @param transactions - Same-owner authorization transactions.
 * @param check - Exact original action evidence.
 * @param authorization - Entry-owned grant, revalidated inside the transaction.
 * @returns Commit closure; failure prevents subsequent runtime dispatch.
 */
export function authorizedCommit(journal: EngineJournal, transactions: T.SeatAuthorizationTransactions,
  check: T.SeatAuthorizationCheck, authorization: T.SeatAuthorizationGrant): ActionCommit {
  return async (build) => {
    for (;;) {
      if (!transactions.validate) throw new EngineError('unavailable', 'Current action authority cannot be checked')
      const refusal = await transactions.validate(check, authorization)
      if (refusal) throw new EngineError(refusal.error.code, refusal.error.message)
      const view = journal.projection
      const sequence = view.sequence
      const effects = build(view)
      if (!effects.length) return
      if (view.authorizationDecisions.some(decision => decision.effects.some(effect =>
        effect.kind === 'authorization/checked' && (effect.data.operationId === check.operationId
          || check.callId !== undefined && effect.data.callId === check.callId)))) {
        throw new EngineError('operation-id-conflict', 'Historical authorization cannot admit another action')
      }
      const admission = { built: false }
      const result = await transactions.transact({ ...check, expectedSequence: sequence,
        decisionId: `authorization:${check.operationId}` as T.EngineDecisionId }, () => {
        admission.built = true
        return { authorization, effects: effects.map(effect => ({ ...effect, operationId: check.operationId })) }
      })
      if (result.status === 'conflict' || result.status === 'committed' && !admission.built) continue
      if (result.status === 'rejected') throw new EngineError(result.error.code, result.error.message)
      if (result.sequence !== sequence + 1) throw new EngineError('operation-id-conflict', 'Historical authorization cannot dispatch another action')
      return
    }
  }
}
