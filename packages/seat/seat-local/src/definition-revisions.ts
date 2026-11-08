/** Exact local revision observations have no business journal entries. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { LocalSeatService } from './service.ts'
import { rejected } from './errors.ts'

/** Register a read provider for one recovered local service, withdrawing before draining observations.
 * @param ctx - Owner of this provider registration.
 * @param seats - Exact local resolver; never a federated directory.
 * @param recovery - Existing local recovery barrier.
 */
export function installDefinitionRevisions(ctx: Context, seats: LocalSeatService, recovery: Promise<void>): void {
  ctx.effect(() => {
    const lifecycle = new AbortController(), pending = new Set<Promise<T.SeatDefinitionRevisionResult>>()
    let recovered = false
    const current = () => !lifecycle.signal.aborted && childProvider()
    const childProvider = () => ctx.get('seatDefinitionRevisions') === provider
    const refusal = (reasonCode: T.NodeWorkChainReasonCode): T.SeatRejected => {
      const result = rejected('invalid-request', 'Exact local revision observation was refused.', 'Use the local seat provider.')
      return { ...result, error: { ...result.error, cause: { domain: 'node-link', code: 'invalid-request',
        reason: reasonCode, reasonCode, effectState: 'none', retryable: false,
        operationId: 'revision' as T.SeatOperationId, nodeId: seats.options.nodeId } } }
    }
    const read = async (request: T.SeatDefinitionRevisionRequest,
      authority: T.SeatCallContext): Promise<T.SeatDefinitionRevisionResult> => {
      if (!recovered || !current()) return refusal('hello-policy-not-ready')
      if (authority.nodeId !== seats.options.nodeId) return refusal('node-mismatch')
      const definition = await seats.resolve(request.seat)
      if (!current()) return refusal('hello-policy-not-ready')
      if ('status' in definition) return refusal('method-not-allowed')
      const admission = definition.remoteAdmission
      if (admission && (!admission.sourceNodeIds.includes(request.sourceOwnerNodeId)
          || !admission.sourceIds.includes(request.sourceId) || !admission.principalIds.includes(authority.principalId)
          || !admission.methods.includes(request.openingMethod))) return refusal('remote-open-not-allowed')
      if (!Number.isSafeInteger(definition.revision) || definition.revision <= 0) return refusal('seat-revision-mismatch')
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
        const work = read(structuredClone(request), authority).catch((_error: unknown) => refusal('method-not-allowed'))
        pending.add(work)
        try { return await work } finally { pending.delete(work) }
      },
    }
    ctx.provide('seatDefinitionRevisions', provider)
    return async () => { lifecycle.abort(); await Promise.allSettled([...pending]) }
  })
}
