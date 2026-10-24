/** 来源解析只在受信进程内注册；注销拒绝新调用并等待已有解析结束。 */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { LocalSeatService } from './service.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'

/** 开窗来源注册表不保存第二份业务真源。 */
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
  /** 解析一次并核版本、摘要和完整任务关联，不解释或拼接来源正文。
   * @param request - 引用及显式任务集合。
   * @param authority - 原调用者的宿主身份。
   * @returns 独立冻结快照或创建前拒绝。
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
  open(request: T.OpenSeatWithContextRequest, authority: T.SeatCallContext): Promise<T.OpenSeatResult> {
    if (!this.active) return Promise.resolve(rejected('unavailable', 'Opening registry is unavailable.', 'Restore the local provider.'))
    return this.service.openWithContext(structuredClone(request), Object.freeze({ ...authority }),
      (input, caller) => this.resolve(input, caller))
  }
  openBatch(request: T.OpenSeatBatchWithScopeRequest, authority: T.SeatCallContext): Promise<T.OpenSeatBatchResult> {
    if (!this.active) return Promise.resolve(rejected('unavailable', 'Opening registry is unavailable.', 'Restore the local provider.'))
    return this.service.openBatchWithScope(structuredClone(request), Object.freeze({ ...authority }))
  }
  /** 停止全部来源并排空在途解析。 */
  async close(): Promise<void> {
    this.active = false
    for (const entry of this.entries.values()) entry.closing = true
    await Promise.allSettled([...this.entries.values()].flatMap(entry => [...entry.pending]))
    this.entries.clear()
  }
}

/** 注册可选服务，生命周期由本地插件负责。
 * @param ctx - 可撤销插件作用域。
 * @param service - 既有本地执行入口。
 * @returns 供引擎冻结器使用的同一注册表。
 */
export function installOpeningContexts(ctx: Context, service: LocalSeatService): OpeningContexts {
  const contexts = new OpeningContexts(service)
  ctx.provide('seatOpeningContexts', contexts)
  ctx.effect(() => () => contexts.close())
  return contexts
}
