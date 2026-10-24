/** Local report and wait facts use the engine's atomic journal rather than another persistence owner. */
import { randomUUID } from 'node:crypto'
import { SEAT_ENGINE_NAMESPACE, type EngineDecision, type EngineEffect, type EngineEventId,
  type SeatEngineService, type SeatNodeId } from '@panedesk/dsh-seat'
import { digest } from './store.ts'
import type { SeatAuthorizationGrant, SeatAuthorizationTransactions } from '@panedesk/dsh-seat'
import { SeatLocalError } from './errors.ts'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

/** Complete committed projection; each mutation re-reads after a CAS conflict. */
export class LocalEngineState {
  constructor(private readonly engine: () => Pick<SeatEngineService, 'query' | 'transact'> | undefined, private readonly nodeId: SeatNodeId,
    private readonly pageSize: number, private readonly retries: number) {}

  /** Read every page at one watermark, retrying a scan changed by concurrent commits.
   * @returns complete committed effects and watermark.
   */
  async read(): Promise<{ effects: EngineEffect[]; watermark: number }> {
    const engine = this.engine()
    if (engine === undefined) throw new Error('Seat engine is unavailable')
    for (let attempt = 0; attempt < this.retries; attempt++) {
      const effects: EngineEffect[] = []
      let cursor: import('@panedesk/dsh-seat').EngineCursor | undefined
      let watermark: number | undefined
      let changed = false
      do {
        const page = await engine.query({ nodeId: this.nodeId, limit: this.pageSize, ...(cursor === undefined ? {} : { cursor }) })
        if (watermark !== undefined && watermark !== page.watermark) { changed = true; break }
        watermark = page.watermark
        effects.push(...page.effects)
        if (page.complete) return { effects, watermark }
        if (page.nextCursor === undefined) throw new Error('Incomplete engine page has no cursor')
        cursor = page.nextCursor
      } while (!changed)
    }
    throw new Error('Engine scan changed repeatedly')
  }

  /** Atomically derive and append facts without publishing speculative state.
   * @param update - pure operation evaluated against each fresh committed snapshot.
   * @param admission - Optional issued authority; omission preserves legacy transactions.
   * @returns result associated with the successful decision or an unchanged snapshot.
   */
  async mutate<T>(update: (effects: readonly EngineEffect[]) => { result: T; effects: readonly EngineEffect[] },
    admission?: { transactions: SeatAuthorizationTransactions; grant: SeatAuthorizationGrant; request: { operationId: import('@panedesk/dsh-seat').SeatOperationId } }): Promise<T> {
    const engine = this.engine()
    if (engine === undefined) throw new Error('Seat engine is unavailable')
    for (let attempt = 0; attempt < this.retries; attempt++) {
      const snapshot = await this.read()
      const next = update(snapshot.effects)
      if (!next.effects.length) return next.result
      if (admission) {
        const { grant, request, transactions } = admission
        const commit = { built: false }
        const receipt = await transactions.transact({ operationId: request.operationId, requestDigest: digest(request),
          expectedSequence: snapshot.watermark, decisionId: `authorization:${request.operationId}` as EngineDecision['decisionId'],
          ...(grant.fact.callId ? { callId: grant.fact.callId } : {}),
          ...(grant.fact.rootCallId ? { rootCallId: grant.fact.rootCallId } : {}) },
        () => { commit.built = true; return { authorization: grant, effects: next.effects } })
        if (receipt.status === 'committed') {
          if (!commit.built) throw new Error('Historical authorization cannot dispatch another local action')
          if (receipt.sequence !== snapshot.watermark + 1) throw new Error('Historical authorization cannot dispatch another local action')
          return next.result
        }
        if (receipt.status === 'rejected') throw new SeatLocalError(receipt.error)
        continue
      }
      const body: Omit<EngineDecision, 'digest' | 'byteLength'> = { namespace: SEAT_ENGINE_NAMESPACE, schemaVersion: 1,
        decisionId: randomUUID() as EngineDecision['decisionId'], sequence: snapshot.watermark + 1,
        observedAt: new Date().toISOString(), nodeId: this.nodeId, policyRevision: 0, effects: next.effects }
      const result = await engine.transact({ expectedSequence: snapshot.watermark,
        decision: { ...body, digest: digest(body), byteLength: Buffer.byteLength(canonical(body)) } })
      if (result.status === 'committed') return next.result
      if (result.status === 'rejected') throw new Error(result.error.message)
    }
    throw new Error('Engine mutation conflicted repeatedly')
  }
}

/** Allocate the event identity before submitting a complete engine decision.
 * @param effect - typed fact and attribution without its generated identity.
 * @returns a fact ready for atomic commit.
 */
export function localFact(effect: { [K in EngineEffect['kind']]:
  Omit<Extract<EngineEffect, { kind: K }>, 'eventId'> }[EngineEffect['kind']]): EngineEffect {
  return { ...effect, eventId: randomUUID() as EngineEventId }
}
