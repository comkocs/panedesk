/** Issued facts and admitted actions share the existing synchronous journal builder. */
import type * as T from '@panedesk/dsh-seat'
import { EngineJournal, EngineError, digest } from './journal.ts'
import { AuthorizationIssuers, authorizationEffect } from './authorization-issuer.ts'
import type { AuthorizationDecision } from './authorization-storage.ts'
import { queryAuthorizations } from './authorization-query.ts'
import { queryOperation } from './operation.ts'
import { fact, rejected } from './triggers.ts'
import { cancelEffects } from './cancellation.ts'

/** One provider owns issuer validation, atomic admission and historical receipts. */
export class AuthorizationTransactions implements T.SeatAuthorizationTransactions {
  constructor(private readonly journal: EngineJournal, private readonly issuers: AuthorizationIssuers,
    private readonly ready: () => Promise<void>, private readonly publish: () => Promise<void>,
    private readonly nodeName: string = journal.nodeId,
    private readonly callbacks?: () => readonly T.SeatCallbackDelivery[]) {}

  async operation(request: T.SeatOperationQuery): Promise<T.SeatEngineOperationResult> {
    await this.ready()
    return queryOperation(this.journal.projection, request, this.nodeName, this.callbacks?.())
  }

  async validate(request: T.SeatAuthorizationCheck, authorization: T.SeatAuthorizationGrant): Promise<T.SeatRejected | null> {
    await this.ready()
    try {
      const data = this.issuers.verify(authorization, request, this.journal.nodeId)
      return data.decision === 'allowed' ? null : rejected('unauthorized', 'Action policy denied the operation')
    } catch (error) { if (!(error instanceof EngineError)) throw error; return failure(error) }
  }

  async transact(request: T.SeatAuthorizationTransactionRequest,
    build: () => T.SeatAuthorizedAction): Promise<T.SeatAuthorizationTransactionResult> {
    await this.ready()
    let result: T.SeatAuthorizationTransactionResult = rejected('invalid-request', 'Authorization action did not commit')
    try {
      await this.journal.commitAuthorization((view) => {
        const replay = view.authorizationDecisions.find(decision => decision.decisionId === request.decisionId
          || decision.effects.some(effect => effect.kind === 'authorization/checked' && (effect.data.operationId === request.operationId
            || request.callId !== undefined && effect.data.callId === request.callId)))
        if (replay) { result = this.receipt(replay, request); return [] }
        if (view.sequence !== request.expectedSequence) { result = { status: 'conflict', sequence: view.sequence }; return [] }
        const action = build()
        const data = this.issuers.verify(action.authorization, request, this.journal.nodeId)
        if (data.decision === 'denied' ? action.effects.length !== 0 : !action.effects.length
          || !action.effects.some(effect => matchesIntent(effect, data))) {
          throw new EngineError('unauthorized', 'Authorization requires matching action intent; denied checks cannot admit effects')
        }
        if (action.effects.some(effect => effect.operationId !== data.operationId
          || data.seat !== undefined && effect.seat !== undefined && effect.seat !== data.seat
          || effect.taskId !== undefined && !data.taskIds.includes(effect.taskId))) {
          throw new EngineError('unauthorized', 'Every action effect must match the issued operation and attribution')
        }
        result = { status: 'committed', decisionId: request.decisionId, sequence: view.sequence + 1,
          authorizationId: data.authorizationId, operationId: data.operationId }
        return [...action.effects, authorizationEffect(data)]
      }, 0, { decisionId: request.decisionId })
    } catch (error) {
      if (!(error instanceof EngineError)) throw error
      return failure(error)
    }
    await this.publish()
    return result
  }

  private receipt(decision: AuthorizationDecision, request: T.SeatAuthorizationTransactionRequest): T.SeatAuthorizationTransactionResult {
    const event = decision.effects.find(effect => effect.kind === 'authorization/checked')
    if (decision.decisionId !== request.decisionId || event?.kind !== 'authorization/checked'
      || event.data.operationId !== request.operationId || event.data.requestDigest !== request.requestDigest
      || event.data.callId !== request.callId || event.data.rootCallId !== request.rootCallId) {
      return rejected('operation-id-conflict', 'Authorization replay changed its decision or action evidence')
    }
    return { status: 'committed', decisionId: decision.decisionId, sequence: decision.sequence,
      authorizationId: event.data.authorizationId, operationId: event.data.operationId }
  }

  async approve(request: T.ApprovePendingSeatRequest, authorization: T.SeatAuthorizationGrant): Promise<T.PendingSeatMutationResult> {
    await this.ready()
    const check = { operationId: request.operationId, requestDigest: digest(request),
      ...(authorization.fact.callId ? { callId: authorization.fact.callId } : {}),
      ...(authorization.fact.rootCallId ? { rootCallId: authorization.fact.rootCallId } : {}) }
    let result: T.PendingSeatMutationResult = rejected('revision-conflict', 'Pending state changed')
    try {
      await this.journal.commitAuthorization((view) => {
        const data = this.issuers.verify(authorization, check, this.journal.nodeId)
        const replay = view.authorizationDecisions.find(decision => decision.effects.some(effect =>
          effect.kind === 'authorization/checked' && effect.data.operationId === request.operationId))
        if (replay) {
          const original = replay.effects.find(effect => effect.kind === 'authorization/checked')
          const approval = replay.effects.find(effect => effect.kind === 'queue/approved')
          const matches = original?.kind === 'authorization/checked' && original.data.requestDigest === check.requestDigest
            && original.data.principalId === data.principalId && original.data.kind === data.kind
            && original.data.callId === data.callId && original.data.rootCallId === data.rootCallId
          if (!matches) result = rejected('operation-id-conflict', 'Approval identity conflicts')
          else if (original.data.decision === 'denied') result = rejected('unauthorized', 'Approval policy denied the operation')
          else result = approval?.kind === 'queue/approved' ? { status: 'approved', queueItemId: approval.data.pending.queueItemId,
            stateVersion: approval.data.pending.stateVersion } : rejected('operation-id-conflict', 'Approval identity conflicts')
          return []
        }
        if (data.decision !== 'allowed') { result = rejected('unauthorized', 'Approval policy denied the operation'); return [authorizationEffect(data)] }
        const previous = view.pending.get(request.queueItemId)
        if (!previous || previous.stateVersion !== request.expectedStateVersion) return []
        if (data.seat !== previous.seat || previous.relatedTaskIds.some(task => !data.taskIds.includes(task))) {
          throw new EngineError('unauthorized', 'Approval attribution does not cover this pending seat and its tasks')
        }
        const pending = { ...previous, stateVersion: previous.stateVersion + 1 }
        result = { status: 'approved', queueItemId: pending.queueItemId, stateVersion: pending.stateVersion }
        return [fact({ kind: 'queue/approved', operationId: request.operationId, data: { pending,
          principalId: data.principalId, previousRevision: previous.stateVersion, revision: pending.stateVersion } }),
        authorizationEffect(data)]
      })
    } catch (error) {
      if (!(error instanceof EngineError)) throw error
      return failure(error)
    }
    await this.publish()
    return result
  }

  async cancel(request: T.CancelPendingSeatRequest, authorization: T.SeatAuthorizationGrant): Promise<T.PendingSeatMutationResult> {
    await this.ready()
    let result: T.PendingSeatMutationResult = rejected('revision-conflict', 'Pending state changed')
    try {
      await this.journal.commitAuthorization((view) => {
        const data = this.issuers.verify(authorization, { operationId: request.operationId, requestDigest: digest(request),
          ...(authorization.fact.callId ? { callId: authorization.fact.callId } : {}),
          ...(authorization.fact.rootCallId ? { rootCallId: authorization.fact.rootCallId } : {}) }, this.journal.nodeId)
        const action = cancelEffects(view, request, data)
        result = action.result
        return action.effects
      })
    } catch (error) { if (!(error instanceof EngineError)) throw error; return failure(error) }
    await this.publish()
    return result
  }

  async query(request: T.SeatIssuedAuthorizationQueryRequest): Promise<T.SeatIssuedAuthorizationQueryResult | T.SeatRejected> {
    await this.ready()
    try { return queryAuthorizations(this.journal.projection.authorizationDecisions, request) }
    catch (error) { if (!(error instanceof EngineError)) throw error; return failure(error) }
  }
}
function matchesIntent(effect: T.EngineEffect, data: T.SeatIssuedAuthorizationFact): boolean {
  if (effect.operationId !== data.operationId) return false
  if (data.seat && effect.seat !== undefined && effect.seat !== data.seat) return false
  return ['open/intent', 'queue/approved', 'window/closing', 'window/replacement', 'wait/registered',
    'cache/keepalive', 'mode/changed', 'budget/reconfigured', 'trigger/accepted', 'trigger/coalesced'].includes(effect.kind)
}
function failure(error: EngineError): T.SeatRejected {
  const result = rejected(error.code, error.message)
  if (error.code === 'unavailable') return { ...result, error: { ...result.error, effectState: 'unknown', retryable: false } }
  return result
}
