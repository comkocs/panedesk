/** Source resolvers register only in the trusted process; disposal rejects new calls and drains active resolutions. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { LocalSeatService } from './service.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'
import { readLocalOpenInput } from './open-input.ts'
import { localSourceId } from './open-admission.ts'

/** The opening source registry does not retain a second business authority. */
export class OpeningContexts implements T.SeatOpeningContexts {
  private readonly entries = new Map<T.OpeningProviderId, {
    provider: T.OpeningContextProvider
    closing: boolean
    pending: Set<Promise<unknown>>
  }>()
  private active = true
  constructor(private readonly service: LocalSeatService) {}
  register(provider: T.OpeningContextProvider): () => Promise<void> {
    if (!this.active) throw new Error('Opening registry is unavailable.')
    if (this.entries.has(provider.providerId)) throw new Error('Opening provider is already registered.')
    const entry = { provider, closing: false, pending: new Set<Promise<unknown>>() }
    this.entries.set(provider.providerId, entry)
    return async () => {
      entry.closing = true
      await Promise.allSettled([...entry.pending])
      if (this.entries.get(provider.providerId) === entry) this.entries.delete(provider.providerId)
    }
  }
  /** Resolve once and verify revision, digest and complete task associations without interpreting or concatenating source text.
   * @param request - Reference and explicit task set.
   * @param authority - Original caller identity authenticated by the host.
   * @returns Independent frozen snapshot, or rejection before creation.
   */
  async resolve(request: Pick<T.OpenSeatWithContextRequest, 'openingContext' | 'relatedTaskIds'>,
    authority: T.SeatCallContext): Promise<T.OpeningContextSnapshot | T.SeatRejected> {
    const entry = this.entries.get(request.openingContext.providerId)
    if (!entry || entry.closing) return rejected('unavailable', 'Opening provider is unavailable.', 'Restore the registered provider.')
    const pending = Promise.resolve().then(() => entry.provider.resolve(structuredClone(request.openingContext), authority))
    entry.pending.add(pending)
    try {
      const value = await pending
      if ('status' in value) return value
      const snapshot = structuredClone(value)
      if (digest(snapshot.reference) !== digest(request.openingContext) || snapshot.revision !== request.openingContext.revision
        || digest(snapshot.text) !== snapshot.digest || Buffer.byteLength(snapshot.text) > this.service.options.maxOpeningBytes
        || new Set(request.relatedTaskIds).size !== request.relatedTaskIds.length
        || new Set(snapshot.taskIds).size !== snapshot.taskIds.length
        || digest([...snapshot.taskIds].sort()) !== digest([...request.relatedTaskIds].sort())) {
        return rejected('invalid-request', 'Opening snapshot does not match the requested revision or tasks.', 'Refresh the provider reference.')
      }
      return snapshot
    } finally { entry.pending.delete(pending) }
  }
  /** Route only journal-authenticated manual references; absent providers leave delivery retryable.
   * @param payload - Original callback retained by the engine outbox.
   */
  async deliver(payload: T.SeatCallbackPayload): Promise<void> {
    if (payload.sourceId !== localSourceId || payload.triggerId === null) return
    const { effects } = await this.service.state.read()
    const accepted = effects.find(effect => (effect.kind === 'trigger/accepted' || effect.kind === 'trigger/coalesced')
      && effect.data.trigger.sourceId === localSourceId && effect.data.trigger.triggerId === payload.triggerId)
    if (!accepted || (accepted.kind !== 'trigger/accepted' && accepted.kind !== 'trigger/coalesced')) {
      throw new Error('Manual callback has no retained admission.')
    }
    const input = readLocalOpenInput(accepted.data.trigger.data)
    if (!input.openingContext) return
    const reference = input.openingContext.reference
    const entry = this.entries.get(reference.providerId)
    if (!this.active || !entry || entry.closing) throw new Error('Opening callback provider is unavailable.')
    if (!entry.provider.callback) return
    const callback = entry.provider.callback.bind(entry.provider)
    const pending = Promise.resolve().then(() => callback(structuredClone(payload), {
      reference: structuredClone(reference), operationId: input.request.operationId,
    }))
    entry.pending.add(pending)
    try { await pending } finally { entry.pending.delete(pending) }
  }
  open(request: T.OpenSeatWithContextRequest, authority: T.SeatCallContext): Promise<T.OpenSeatResult> {
    if (!this.active) return Promise.resolve(rejected('unavailable', 'Opening registry is unavailable.', 'Restore the local provider.'))
    return this.service.openWithContext(structuredClone(request), Object.freeze({ ...authority }),
      (input, caller) => this.resolve(input, caller))
  }
  wake(request: T.WakeSeatWithContextRequest, authority: T.SeatCallContext): Promise<T.WakeSeatResult> {
    if (!this.active) return Promise.resolve(rejected('unavailable', 'Opening registry is unavailable.', 'Restore the local provider.'))
    const { openingContext, relatedTaskIds, ...base } = structuredClone(request)
    const caller = Object.freeze({ ...authority })
    return this.service.wakeWithContext(base, caller, input => this.open({ ...input,
      openingContext, relatedTaskIds }, caller))
  }
  openBatch(request: T.OpenSeatBatchWithScopeRequest, authority: T.SeatCallContext): Promise<T.OpenSeatBatchResult> {
    if (!this.active) return Promise.resolve(rejected('unavailable', 'Opening registry is unavailable.', 'Restore the local provider.'))
    return this.service.openBatchWithScope(structuredClone(request), Object.freeze({ ...authority }))
  }
  /** Stop all sources and drain active resolutions. */
  async close(): Promise<void> {
    this.active = false
    for (const entry of this.entries.values()) entry.closing = true
    await Promise.allSettled([...this.entries.values()].flatMap(entry => [...entry.pending]))
    this.entries.clear()
  }
}

/** Register optional services whose lifecycle belongs to the local plugin.
 * @param ctx - Revocable plugin scope.
 * @param service - Existing local execution entry.
 * @returns The same registry used by the engine freezer.
 */
export function installOpeningContexts(ctx: Context, service: LocalSeatService): OpeningContexts {
  const contexts = new OpeningContexts(service)
  ctx.provide('seatOpeningContexts', contexts)
  ctx.effect(() => () => contexts.close())
  return contexts
}
