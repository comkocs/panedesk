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
      const lifecycle = new AbortController(), pending = new Set<Promise<T.NodeWorkChainOperationResult>>()
      let recovered = false
      let recovery: Promise<void> | undefined
      const query = async (request: T.NodeWorkChainOperationRequest,
        context: T.SeatCallContext): Promise<T.NodeWorkChainOperationResult> => {
        const grant = context.authorization, fact = grant?.fact
        if (!grant || !fact || fact.kind !== 'node-delegation' || !fact.sourceNodeId
          || request.key.method !== 'engine.acceptFrozen' || fact.sourceNodeId !== request.key.sourceNodeId
          || fact.principalId !== request.key.principalId || context.principalId !== fact.principalId) {
          return rejected('unauthorized', 'Frozen query attribution does not match')
        }
        const refusal = await engine.authorizations.validate({ operationId: fact.operationId, requestDigest: digest(request),
          ...(fact.callId ? { callId: fact.callId } : {}), ...(fact.rootCallId ? { rootCallId: fact.rootCallId } : {}) }, grant)
        return refusal ?? structuredClone(queryFrozen(engine.journal.projection, request))
      }
      const provider: T.NodeWorkChainBusinessProvider = { methods: ['engine.acceptFrozen'], ready: () => {
        recovery ??= engine.ready().then(async () => {
          await registry.ready(['seat.openFrozen', 'seat.wakeFrozen'])
          recovered = !lifecycle.signal.aborted
        })
        return recovery
      },
      query: (request, context) => {
        if (lifecycle.signal.aborted) return Promise.resolve(rejected('unavailable', 'Frozen query provider was revoked'))
        if (!recovered) return Promise.resolve({ status: 'pending', effectState: 'unknown' })
        const work = query(request, context)
        pending.add(work)
        return work.finally(() => pending.delete(work))
      } }
      const unregister = registry.register(provider)
      return async () => { lifecycle.abort(); unregister(); await Promise.allSettled([...pending]) }
    })
  })
}
