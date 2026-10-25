/** Seat business queries use recovered admission facts, never transport receipts. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { LocalSeatService } from './service.ts'
import { querySeatFrozen } from './frozen-admission.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'

/** Scope query registration to the existing engine recovery and the optional chain registry.
 * @param ctx - Local admission lifecycle owner.
 * @param seats - Recovered local service.
 * @param recovery - Restoration of all existing local intents and observations.
 */
export function installSeatFrozenBusiness(ctx: Context, seats: LocalSeatService, recovery: Promise<void>): void {
  ctx.inject(['nodeWorkChainBusiness'], (child) => {
    const registry = child.get('nodeWorkChainBusiness')
    if (!registry) return
    child.effect(() => {
      let recovered = false
      const ready = recovery.then(() => { recovered = true })
      void ready.catch((_error: unknown) => { /* Recovery failure is retained for the capability barrier. */ })
      const provider: T.NodeWorkChainBusinessProvider = { methods: ['seat.openFrozen', 'seat.wakeFrozen'], ready: () => ready,
        query: async (request, context) => {
          if (!recovered) return { status: 'pending', effectState: 'unknown' }
          const grant = context.authorization, fact = grant?.fact, transactions = child.get('seatAuthorizationTransactions')
          if (!grant || !fact || !transactions?.validate
            || !provider.methods.includes(request.key.method as T.NodeWorkChainBusinessMethod)) {
            return rejected('unauthorized', 'Frozen query requires live authority.', 'Restore the authenticated entry.')
          }
          const refusal = await transactions.validate({ operationId: fact.operationId, requestDigest: digest(request),
            ...(fact.callId ? { callId: fact.callId } : {}), ...(fact.rootCallId ? { rootCallId: fact.rootCallId } : {}) }, grant)
          return refusal ?? structuredClone(querySeatFrozen((await seats.state.read()).effects, request, context))
        } }
      return registry.register(provider)
    })
  })
}
