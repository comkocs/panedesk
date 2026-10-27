/** Independently versioned intents retain pending business stages across process loss. */
import { digest, object, parseJson, type PrivateFiles } from '@panedesk/dsh-host-admin'
import type { NodeWorkChainOperationKey, SeatDigest } from '@panedesk/dsh-seat'
import type { ChainRequest, ChainResponse } from './chain-types.ts'
import { decodeChainRequest, decodeChainResponse } from './chain-codec.ts'
import { chainKey, chainKeyText, chainPending, chainRecoveryEligible, chainTransportNone } from './chain-identity.ts'

type Entry = {
  request: ChainRequest
  response?: ChainResponse
  transportNone?: boolean
  recovery?: { attemptId: string; history: { response: ChainResponse; reactivatedAt: string }[] }
}
type Outcome = { state: 'missing' | 'pending' | 'conflict' } | { state: 'settled'; response: ChainResponse }

/** A store serializes only file publication, never execution or evidence queries. */
export class ChainStore {
  private entries: Record<string, Entry> = {}
  private serial: Promise<void> = Promise.resolve()
  private failed = false
  private readonly limits: { maxBytes: number; maxEntries: number }
  constructor(private readonly files: PrivateFiles, maxBytes: number, maxEntries: number) {
    this.limits = { maxBytes, maxEntries }
  }

  /** Load and validate every retained identity before ingress becomes available.
   * @returns Completion after the independent chain generation is verified.
   */
  async load(): Promise<void> {
    await this.files.prepare()
    const text = await this.files.read('chain-v1.json', this.limits.maxBytes)
    if (text === null) return
    const value = parseJson(text, this.limits.maxBytes)
    if (!object(value) || value.version !== 'node-work-chain/v1' || !object(value.entries)
      || Object.keys(value.entries).length > this.limits.maxEntries) throw new Error('Node chain store rejected')
    const entries: Record<string, Entry> = {}
    for (const [key, item] of Object.entries(value.entries)) {
      if (!object(item) || Object.keys(item).some(field => !['request', 'response', 'transportNone', 'recovery'].includes(field))) throw new Error('Node chain entry rejected')
      const request = decodeChainRequest(item.request)
      if (request.method === 'chain.operation' || request.method === 'seat.definitionRevision' || key !== digest(chainKeyText(chainKey(request)))) throw new Error('Node chain store identity rejected')
      const response = item.response === undefined ? undefined : decodeChainResponse(item.response, request)
      if (response !== undefined && chainPending(response)) throw new Error('Node chain terminal stage rejected')
      const entry: Entry = response === undefined ? { request } : { request, response }
      if (item.transportNone !== undefined) {
        if (typeof item.transportNone !== 'boolean' || !chainTransportNone(response)) throw new Error('Node chain transport receipt rejected')
        entry.transportNone = item.transportNone
      }
      if (item.recovery !== undefined) {
        const recovery = item.recovery
        if (!object(recovery) || Object.keys(recovery).some(field => !['attemptId', 'history'].includes(field))
          || typeof recovery.attemptId !== 'string' || !recovery.attemptId || !Array.isArray(recovery.history)
          || recovery.history.length === 0) throw new Error('Node chain recovery rejected')
        entry.recovery = { attemptId: recovery.attemptId, history: recovery.history.map((value) => {
          if (!object(value) || Object.keys(value).some(field => !['response', 'reactivatedAt'].includes(field))
            || typeof value.reactivatedAt !== 'string' || !Number.isFinite(Date.parse(value.reactivatedAt))) {
            throw new Error('Node chain recovery history rejected')
          }
          const previous = decodeChainResponse(value.response, request)
          if (!chainTransportNone(previous)) throw new Error('Node chain recovery receipt rejected')
          return { response: previous, reactivatedAt: value.reactivatedAt }
        }) }
      }
      entries[key] = entry
    }
    this.entries = entries
  }

  /** Observe transport evidence; missing is not a claim about business recovery.
   * @param key - Exact original business key.
   * @param payloadDigest - Complete frozen payload digest.
   * @returns Retained receipt or nonterminal state.
   */
  query(key: NodeWorkChainOperationKey, payloadDigest: SeatDigest): Outcome {
    if (this.failed) throw new Error('Node chain store unavailable')
    const entry = this.entries[digest(chainKeyText(key))]
    if (entry === undefined) return { state: 'missing' }
    if (entry.request.payloadDigest !== payloadDigest) return { state: 'conflict' }
    return entry.response === undefined ? { state: 'pending' } : { state: 'settled', response: entry.response }
  }

  /** Persist an immutable intent before invoking its business owner.
   * @param input - Authenticated request whose business key has not changed.
   * @returns Whether this invocation created the intent, or an existing outcome.
   */
  admit(input: ChainRequest): Promise<{ state: 'admitted' } | Outcome> {
    const request = decodeChainRequest(JSON.parse(JSON.stringify(input)))
    return this.enqueue(async () => {
      if (request.method === 'chain.operation' || request.method === 'seat.definitionRevision') throw new Error('Node chain query cannot create intent')
      const previous = this.query(chainKey(request), request.payloadDigest)
      if (previous.state !== 'missing') return previous
      if (Object.keys(this.entries).length >= this.limits.maxEntries) throw new Error('Node chain capacity exceeded')
      await this.publish({ ...this.entries, [digest(chainKeyText(chainKey(request)))]: { request } })
      return { state: 'admitted' as const }
    })
  }

  /** Repair a receipt from authenticated business evidence, preserving original intent.
   * @param request - Original key and frozen payload.
   * @param input - Correlated result; pending and unknown are never cached terminally.
   * @param transportNone - Sender classification: true for local refusal, false for owner evidence; omission preserves legacy metadata.
   * @returns Completion after any terminal receipt is durably published.
   */
  settle(request: ChainRequest, input: ChainResponse, transportNone?: boolean): Promise<void> {
    const response = decodeChainResponse(JSON.parse(JSON.stringify(input)), request)
    return this.enqueue(async () => {
      const key = digest(chainKeyText(chainKey(request))), entry = this.entries[key]
      if (entry === undefined || entry.request.payloadDigest !== request.payloadDigest) throw new Error('Node chain settlement identity rejected')
      if (chainPending(response) || entry.response !== undefined
        || (entry.recovery && entry.recovery.attemptId !== request.requestId)) return
      const retained = decodeChainResponse({ ...response, requestId: entry.request.requestId }, entry.request)
      await this.publish({ ...this.entries, [key]: { ...entry, response: retained,
        ...(chainTransportNone(retained) && transportNone !== undefined ? { transportNone } : {}) } })
    })
  }

  /** Compare the original key, digest and observed receipt before a single recovery attempt.
   * @param request - Original frozen intent with the new attempt's wire identifier.
   * @param expected - Detached state observed before the authenticated owner query.
   * @returns Whether this attempt owns the unchanged recoverable entry after publication.
   */
  reactivate(request: ChainRequest, expected: Outcome): Promise<boolean> {
    return this.enqueue(async () => {
      const key = digest(chainKeyText(chainKey(request))), entry = this.entries[key]
      if (!entry || !this.recoverable(entry) || entry.request.payloadDigest !== request.payloadDigest
        || digest(this.query(chainKey(request), request.payloadDigest)) !== digest(expected)) return false
      if (entry.response === undefined) {
        if (entry.recovery) await this.publish({ ...this.entries,
          [key]: { ...entry, recovery: { ...entry.recovery, attemptId: request.requestId } } })
        return true
      }
      const history = [...(entry.recovery?.history ?? []), { response: entry.response, reactivatedAt: new Date().toISOString() }]
      await this.publish({ ...this.entries, [key]: { request: entry.request,
        recovery: { attemptId: request.requestId, history } } })
      return true
    })
  }

  /** Enumerate private pending intents and local transport refusals for recovery.
   * @returns Detached requests that cannot mutate retained state.
   */
  pending(): readonly ChainRequest[] {
    if (this.failed) throw new Error('Node chain store unavailable')
    return Object.values(this.entries).filter(entry => this.recoverable(entry))
      .map(entry => decodeChainRequest(JSON.parse(JSON.stringify(entry.request))))
  }

  /** Drain file publications before releasing exclusive directory ownership.
   * @returns Completion after every accepted publication.
   */
  async close(): Promise<void> { await this.serial }

  private recoverable(entry: Entry): boolean {
    return entry.transportNone !== false && chainRecoveryEligible(entry.request.method, entry.response)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(() => {
      if (this.failed) throw new Error('Node chain store unavailable')
      return work()
    })
    this.serial = result.then(() => {}, () => {})
    return result
  }
  private async publish(entries: Record<string, Entry>): Promise<void> {
    const text = JSON.stringify({ version: 'node-work-chain/v1', entries })
    if (Buffer.byteLength(text) > this.limits.maxBytes) throw new Error('Node chain store exceeds limit')
    try { await this.files.write('chain-v1.json', text) }
    catch (error) { this.failed = true; throw error }
    this.entries = entries
  }
}
