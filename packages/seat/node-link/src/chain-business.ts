/** Exclusive business ownership and recovery readiness are scoped to one node-link instance. */
import type { NodeWorkChainBusinessMethod, NodeWorkChainBusinessProvider, NodeWorkChainBusinessRegistry,
  NodeWorkChainOperationRequest, NodeWorkChainOperationResult, SeatCallContext } from '@panedesk/dsh-seat'

type Entry = { provider: NodeWorkChainBusinessProvider; ready?: Promise<void>; recovered: boolean }

/** Provider disposal invalidates all readiness observations made for that registration. */
export class ChainBusinessRegistry implements NodeWorkChainBusinessRegistry {
  private readonly entries = new Map<NodeWorkChainBusinessMethod, Entry>()

  register(provider: NodeWorkChainBusinessProvider): () => void {
    const methods = [...provider.methods]
    if (methods.length === 0 || new Set(methods).size !== methods.length
      || methods.some(method => this.entries.has(method))) throw new Error('Node chain business provider conflict')
    const entry: Entry = { provider, recovered: false }
    for (const method of methods) this.entries.set(method, entry)
    return () => {
      for (const method of methods) if (this.entries.get(method) === entry) this.entries.delete(method)
    }
  }

  resolve(method: NodeWorkChainBusinessMethod): NodeWorkChainBusinessProvider | undefined {
    return this.entries.get(method)?.provider
  }

  async ready(methods: readonly NodeWorkChainBusinessMethod[]): Promise<void> {
    const entries = methods.map((method) => {
      const entry = this.entries.get(method)
      if (!entry) throw new Error('Node chain business provider unavailable')
      return entry
    })
    await Promise.all([...new Set(entries)].map((entry) => {
      entry.ready ??= Promise.resolve().then(() => entry.provider.ready()).then(() => { entry.recovered = true })
      return entry.ready
    }))
    if (methods.some((method, index) => this.entries.get(method) !== entries[index])) {
      throw new Error('Node chain business provider withdrawn')
    }
  }

  /** Observe current registrations, not readiness from a withdrawn provider.
   * @param methods - Exact receiving method set.
   * @returns Whether every current owner has completed its recovery barrier.
   */
  isReady(methods: readonly NodeWorkChainBusinessMethod[]): boolean {
    return methods.every(method => this.entries.get(method)?.recovered === true)
  }

  /** Query only the current recovered owner; no transport receipt implies business absence.
   * @param request - Authenticated original complete key and frozen payload digest.
   * @param context - Locally issued authority, never wire-supplied context.
   * @returns Current business evidence; unavailable or changing ownership remains unknown.
   */
  async query(request: NodeWorkChainOperationRequest, context: SeatCallContext): Promise<NodeWorkChainOperationResult> {
    const unknown: NodeWorkChainOperationResult = { status: 'pending', effectState: 'unknown' }
    if (request.key.method === 'chain.operation') return unknown
    const entry = this.entries.get(request.key.method)
    if (!entry?.recovered) return unknown
    const result = await entry.provider.query(request, context)
    if (this.entries.get(request.key.method) !== entry) return unknown
    if (result.status === 'settled' && result.method !== request.key.method) throw new Error('Node chain business result method rejected')
    return result
  }
}
