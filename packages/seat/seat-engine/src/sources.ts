/** Installed source ownership is transient; accepted work belongs to the journal. */
import type { SeatSourceId, SeatTriggerSource } from '@panedesk/dsh-seat'
import { EngineError } from './journal.ts'

/** Source disposal prevents new ingress and waits for already-owned operations. */
export class SourceRegistry {
  private readonly entries = new Map<SeatSourceId, { source: SeatTriggerSource; pending: Set<Promise<unknown>>; closing: boolean }>()
  /** Register trusted callback code without writing addresses or credentials.
   * @param source - authenticated adapter.
   * @returns awaited contribution disposer.
   */
  register(source: SeatTriggerSource): () => Promise<void> {
    if (this.entries.has(source.sourceId)) throw new EngineError('invalid-request', 'Source is already registered')
    const entry = { source, pending: new Set<Promise<unknown>>(), closing: false }
    this.entries.set(source.sourceId, entry)
    return async () => {
      entry.closing = true
      await Promise.allSettled([...entry.pending])
      if (this.entries.get(source.sourceId) === entry) this.entries.delete(source.sourceId)
    }
  }
  /** Own ingress or delivery through the adapter's complete settlement.
   * @param id - registered source identity.
   * @param operation - work admitted before disposal begins.
   * @returns the operation outcome.
   */
  async use<T>(id: SeatSourceId, operation: (source: SeatTriggerSource) => Promise<T>): Promise<T> {
    const entry = this.entries.get(id)
    if (!entry || entry.closing) throw new EngineError('source-not-found', 'Install the registered source before retrying')
    const pending = Promise.resolve().then(() => operation(entry.source))
    entry.pending.add(pending)
    try { return await pending } finally { entry.pending.delete(pending) }
  }
  /** Stop new calls before draining all installed adapters. */
  async close(): Promise<void> {
    for (const entry of this.entries.values()) entry.closing = true
    await Promise.allSettled([...this.entries.values()].flatMap(entry => [...entry.pending]))
    this.entries.clear()
  }
}
