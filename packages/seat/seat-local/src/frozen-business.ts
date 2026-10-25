/** Seat business queries use recovered admission facts, never transport receipts. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { LocalSeatService } from './service.ts'
import { querySeatFrozen } from './frozen-admission.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'
import { SeatEngine } from '@panedesk/dsh-seat-engine'

/** Scope query registration to the existing engine recovery and the optional chain registry.
 * @param ctx - Local admission lifecycle owner.
 * @param seats - Recovered local service.
 * @param recovery - Restoration of all existing local intents and observations.
 */
export function installSeatFrozenBusiness(ctx: Context, seats: LocalSeatService, recovery: Promise<void>): void {
  ctx.inject(['nodeWorkChainBusiness', 'nodeWorkChain'], (child) => {
    const registry = child.get('nodeWorkChainBusiness')
    if (!registry) return
    child.effect(() => {
      const lifecycle = new AbortController(), pending = new Set<Promise<T.NodeWorkChainOperationResult>>()
      const writes = seats.frozenWrites.register()
      let recovered = false
      const ready = recovery
      void ready.catch((_error: unknown) => { /* Recovery failure is retained for the capability barrier. */ })
      const query = async (request: T.NodeWorkChainOperationRequest,
        context: T.SeatCallContext): Promise<T.NodeWorkChainOperationResult> => {
        const grant = context.authorization, fact = grant?.fact, transactions = child.get('seatAuthorizationTransactions')
        if (!grant || !fact || !transactions?.validate
          || !provider.methods.includes(request.key.method as T.NodeWorkChainBusinessMethod)) {
          return rejected('unauthorized', 'Frozen query requires live authority.', 'Restore the authenticated entry.')
        }
        const refusal = await transactions.validate({ operationId: fact.operationId, requestDigest: digest(request),
          ...(fact.callId ? { callId: fact.callId } : {}), ...(fact.rootCallId ? { rootCallId: fact.rootCallId } : {}) }, grant)
        if (refusal) return refusal
        const engine = child.get('seatEngine')
        if (engine instanceof SeatEngine && request.key.method === 'seat.wakeFrozen') {
          const delivery = engine.wakeDeliveries.query(request, context)
          if (delivery.status !== 'missing') return delivery
        }
        return structuredClone(querySeatFrozen((await seats.state.read()).effects, request, context))
      }
      const provider: T.NodeWorkChainBusinessProvider = { methods: ['seat.openFrozen', 'seat.wakeFrozen'],
        ready: () => ready.then(() => { recovered = !lifecycle.signal.aborted; if (recovered) writes.ready() }),
        query: async (request, context) => {
          if (lifecycle.signal.aborted) return rejected('unavailable', 'Frozen query provider was revoked.', 'Restore the provider.')
          if (!recovered) return { status: 'pending', effectState: 'unknown' }
          const work = query(request, context)
          pending.add(work)
          try { return await work } finally { pending.delete(work) }
        } }
      const unregister = registry.register(provider)
      return async () => {
        lifecycle.abort(); const drained = writes.close(); unregister(); await drained; await Promise.allSettled([...pending])
      }
    })
  })
}
