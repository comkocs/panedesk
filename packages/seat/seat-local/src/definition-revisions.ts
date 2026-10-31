/** Exact local revision observations have independent authority and no business journal entries. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { LocalSeatService } from './service.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'

/** Register a read provider for one recovered local service, withdrawing before draining observations.
 * @param ctx - Owner of this provider registration and its authorization dependency.
 * @param seats - Exact local resolver; never a federated directory.
 * @param recovery - Existing local recovery barrier.
 */
export function installDefinitionRevisions(ctx: Context, seats: LocalSeatService, recovery: Promise<void>): void {
  ctx.inject(['seatAuthorizationTransactions'], (child) => {
    child.effect(() => {
      const transactions = child.get('seatAuthorizationTransactions')
      const lifecycle = new AbortController(), pending = new Set<Promise<T.SeatDefinitionRevisionResult>>()
      let recovered = false
      const current = () => !lifecycle.signal.aborted && child.get('seatDefinitionRevisions') === provider
        && child.get('seatAuthorizationTransactions') === transactions
      const refusal = (reasonCode: T.NodeWorkChainReasonCode, authority: T.SeatCallContext): T.SeatRejected => {
        const result = rejected('unauthorized', 'Exact local revision observation was refused.', 'Restore the explicit read authority and local provider.')
        if (!authority.authorization) return result
        return { ...result, error: { ...result.error, cause: { domain: 'node-link', code: 'unauthorized',
          reason: reasonCode, reasonCode, effectState: 'none', retryable: false,
          operationId: authority.authorization.fact.operationId, nodeId: seats.options.nodeId } } }
      }
      const read = async (request: T.SeatDefinitionRevisionRequest,
        authority: T.SeatCallContext): Promise<T.SeatDefinitionRevisionResult> => {
        const grant = authority.authorization, fact = grant?.fact
        if (!recovered || !current()) return refusal('hello-policy-not-ready', authority)
        if (!grant || !fact || !transactions?.validate) return refusal('method-not-allowed', authority)
        if (fact.kind !== 'node-delegation' || fact.nodeId !== seats.options.nodeId || authority.nodeId !== fact.nodeId
          || !fact.sourceNodeId || fact.sourceNodeId === fact.nodeId
            && (fact.origin !== 'manual' || fact.reasonCode !== 'trusted-local-owner')
          || ![fact.nodeId, fact.sourceNodeId].includes(request.sourceOwnerNodeId)) return refusal('node-mismatch', authority)
        if (fact.principalId !== authority.principalId) return refusal('principal-mismatch', authority)
        if (fact.seat !== request.seat || digest(fact.taskIds) !== digest(request.taskIds)
          || fact.requestDigest !== digest(request)) return refusal('evidence-digest-mismatch', authority)
        const scope = { operationId: fact.operationId, requestDigest: digest(request),
          ...(fact.callId ? { callId: fact.callId } : {}), ...(fact.rootCallId ? { rootCallId: fact.rootCallId } : {}) }
        const denied = await transactions.validate(scope, grant)
        if (denied) return refusal('method-not-allowed', authority)
        if (!current()) return refusal('hello-policy-not-ready', authority)
        const definition = await seats.resolve(request.seat)
        if (await transactions.validate(scope, grant)) return refusal('method-not-allowed', authority)
        if (!current()) return refusal('hello-policy-not-ready', authority)
        if ('status' in definition) return refusal('method-not-allowed', authority)
        const admission = definition.remoteAdmission
        if (!admission?.allowOpen || !admission.sourceNodeIds.includes(fact.sourceNodeId)
          || !admission.sourceIds.includes(request.sourceId) || !admission.principalIds.includes(fact.principalId)
          || !admission.methods.includes(request.openingMethod)) return refusal('remote-open-not-allowed', authority)
        if (!Number.isSafeInteger(definition.revision) || definition.revision <= 0) return refusal('seat-revision-mismatch', authority)
        return { status: 'found', nodeId: seats.options.nodeId, seat: request.seat, revision: definition.revision }
      }
      const provider: T.SeatDefinitionRevisionProvider = {
        ready: async () => {
          await recovery
          if (!current()) throw new Error('Local revision provider withdrawn')
          recovered = true
        },
        available: () => recovered && current(),
        read: async (request, authority) => {
          const work = read(structuredClone(request), authority).catch((_error: unknown) => refusal('method-not-allowed', authority))
          pending.add(work)
          try { return await work } finally { pending.delete(work) }
        },
      }
      child.provide('seatDefinitionRevisions', provider)
      return async () => { lifecycle.abort(); await Promise.allSettled([...pending]) }
    })
  })
}
