/** The chain registry advertises engine ingress only while recovered local admission is available. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { SeatEngine } from './engine.ts'
import { queryFrozen } from './frozen-admission.ts'
import { digest } from './journal.ts'
import { rejected } from './triggers.ts'

/** Register the engine-owned method without creating a registry or touching the default installation.
 * @param ctx - Engine lifecycle owner.
 * @param engine - Sole journal owner.
 */
export function installFrozenBusiness(ctx: Context, engine: SeatEngine): void {
  ctx.inject(['nodeWorkChainBusiness', 'seats'], (child) => {
    const registry = child.get('nodeWorkChainBusiness')
    if (!registry) return
    child.effect(() => {
      let recovered = false
      let recovery: Promise<void> | undefined
      const provider: T.NodeWorkChainBusinessProvider = { methods: ['engine.acceptFrozen'], ready: () => {
        recovery ??= engine.ready().then(async () => {
          await registry.ready(['seat.openFrozen', 'seat.wakeFrozen'])
          recovered = true
        })
        return recovery
      },
      query: async (request, context) => {
        if (!recovered) return { status: 'pending', effectState: 'unknown' }
        const grant = context.authorization, fact = grant?.fact
        if (!grant || !fact || fact.kind !== 'node-delegation' || !fact.sourceNodeId
            || request.key.method !== 'engine.acceptFrozen' || fact.sourceNodeId !== request.key.sourceNodeId
            || fact.principalId !== request.key.principalId || context.principalId !== fact.principalId) {
          return rejected('unauthorized', 'Frozen query attribution does not match')
        }
        const refusal = await engine.authorizations.validate({ operationId: fact.operationId, requestDigest: digest(request),
          ...(fact.callId ? { callId: fact.callId } : {}), ...(fact.rootCallId ? { rootCallId: fact.rootCallId } : {}) }, grant)
        return refusal ?? structuredClone(queryFrozen(engine.journal.projection, request))
      } }
      return registry.register(provider)
    })
  })
}
