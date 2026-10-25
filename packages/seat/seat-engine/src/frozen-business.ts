/** The chain registry advertises engine ingress only while recovered local admission is available. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { SeatEngine } from './engine.ts'
import { queryFrozen } from './frozen-admission.ts'
import { digest } from './journal.ts'
import { rejected } from './triggers.ts'

/** One admission owner rejects new writes before awaiting all previously admitted work. */
export class FrozenWriteBarrier {
  private readonly lifecycle = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private registration?: { ready: boolean; revoked: boolean }

  /** Bind readiness to this registration, never to a replaced provider.
   * @returns Registration-owned readiness and withdrawal operations.
   */
  register(): { ready(): void; close(): Promise<void> } {
    const registration = { ready: false, revoked: false }
    this.registration = registration
    return { ready: () => { if (!registration.revoked) registration.ready = true },
      close: async () => { registration.revoked = true; await this.drain() } }
  }

  /** Admit a write only while its provider and optional registration remain ready.
   * @param work - Complete write, including its first acknowledgement.
   * @returns Original result or a no-effect lifecycle refusal.
   */
  run<R>(work: () => Promise<R>): Promise<R | T.SeatRejected> {
    if (this.lifecycle.signal.aborted || this.registration?.revoked) {
      return Promise.resolve(rejected('unavailable', 'Frozen write provider was revoked'))
    }
    if (this.registration && !this.registration.ready) {
      return Promise.resolve(rejected('unavailable', 'Frozen write provider is recovering'))
    }
    const result = Promise.resolve().then(work)
    this.pending.add(result)
    return result.finally(() => { this.pending.delete(result) })
  }

  /** Revoke immediately, retaining resources until accepted writes settle.
   * @returns Completion after all accepted writes settle.
   */
  close(): Promise<void> { this.lifecycle.abort(); return this.drain() }

  private async drain(): Promise<void> { await Promise.allSettled([...this.pending]) }
}

/** Register the engine-owned method without creating a registry or touching the default installation.
 * @param ctx - Engine lifecycle owner.
 * @param engine - Sole journal owner.
 */
export function installFrozenBusiness(ctx: Context, engine: SeatEngine): void {
  ctx.inject(['nodeWorkChainBusiness', 'nodeWorkChain', 'seats'], (child) => {
    const registry = child.get('nodeWorkChainBusiness')
    if (!registry) return
    child.effect(() => {
      const lifecycle = new AbortController(), pending = new Set<Promise<T.NodeWorkChainOperationResult>>()
      const writes = engine.frozenWrites.register()
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
          if (recovered) writes.ready()
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
      return async () => {
        lifecycle.abort(); const drained = writes.close(); unregister(); await Promise.allSettled([...pending, drained])
      }
    })
  })
}
