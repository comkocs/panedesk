/** The engine journal owns authorized wake intents and recovery with stable delivery identities. */
import { randomUUID } from 'node:crypto'
import type * as T from '@panedesk/dsh-seat'
import type { EngineJournal } from './journal.ts'
import { digest, EngineError } from './journal.ts'
import { frozenIdentity } from './frozen-admission.ts'
import type { WakeCaller } from './wake-storage.ts'
import { rejected } from './triggers.ts'
import { validChainAccepted } from './chain-storage.ts'
import { wakeDeliveryId, wakeKey, wakeRecords, type WakeDeliveryRecord } from './wake-storage.ts'

/** Delivery uses the local runtime's persistent sender, not a second inbox implementation. */
export type WakeSender = (request: { sessionId: WakeDeliveryRecord['action']['sessionId']
  operationId: T.SeatOperationId
  text: string
  mode: 'queue' }) => Promise<{ messageId: Extract<T.WakeSeatResult, { status: 'sent' | 'stored-budget-stopped' }>['messageId'] }>
/** This instance shares the engine's journal owner and serial admission slot. */
export class WakeDeliveries {
  constructor(private readonly journal: EngineJournal, private readonly contextLimit?: number) {}

  /** Read an exact replay before evaluating any new-admission policy.
   * @param payload - Original wire payload.
   * @param authority - Authenticated receiving identity.
   * @returns First receipt, pending intent, conflict, or absence.
   */
  find(payload: T.WakeSeatRequest | T.WakeFrozenSeatRequest,
    authority: T.SeatCallContext): WakeDeliveryRecord | T.SeatRejected | undefined {
    const caller = this.caller(payload, authority)
    const request = 'request' in payload ? payload.request : payload
    if (request.nodeId !== undefined && request.nodeId !== this.journal.nodeId) {
      return rejected('invalid-request', 'Wake input targets another node')
    }
    const record = wakeRecords(this.journal.projection.authorizationDecisions).get(wakeKey({
      method: 'request' in payload ? 'seat.wakeFrozen' : 'seat.wake', payload, original: caller }))
    return record && record.original.requestDigest !== digest(payload)
      ? rejected('operation-id-conflict', 'Wake operation payload conflicts') : record
  }
  private caller(payload: T.WakeSeatRequest | T.WakeFrozenSeatRequest, authority: T.SeatCallContext): WakeCaller {
    const request = 'request' in payload ? payload.request : payload
    return { sourceNodeId: 'route' in payload ? payload.route.sourceOwnerNodeId : authority.nodeId,
      principalId: authority.principalId, nodeId: authority.nodeId, seat: request.seat,
      operationId: request.operationId, requestDigest: digest(payload) }
  }

  /** Bind current authorization and the frozen local action in one synchronized frame.
   * @param payload - Original wire input, including fallback evidence when present.
   * @param authority - Live instance-owned grant.
   * @param definition - Current target seat definition.
   * @param binding - Selected local window's retained seat and tasks.
   * @param action - Frozen text, title and budget disposition.
   * @param send - Existing persistent local message sender.
   * @returns First durable acknowledgement.
   */
  async deliver(payload: T.WakeSeatRequest | T.WakeFrozenSeatRequest, authority: T.SeatCallContext,
    definition: T.SeatDefinition, binding: Extract<T.SeatBinding, { kind: 'seat' }>,
    action: Omit<WakeDeliveryRecord['action'], 'operationId'>, send: WakeSender): Promise<T.WakeSeatResult> {
    try {
      await this.journal.commitAuthorization(() => {
        const existing = this.find(payload, authority)
        if (existing && 'status' in existing) throw new EngineError(existing.error.code, existing.error.message)
        if (existing) return []
        const input = 'request' in payload ? frozenIdentity(payload, authority, 'seat.wakeFrozen') : undefined
        if (input && 'status' in input) throw new EngineError(input.error.code, input.error.message)
        if (input && !validChainAccepted(input)) throw new EngineError('invalid-request', 'Frozen wake evidence is inconsistent')
        const original = this.caller(payload, authority)
        if (original.seat !== definition.seat || binding.seat !== definition.seat
          || binding.nodeId !== this.journal.nodeId || action.sessionId !== binding.sessionId) {
          throw new EngineError('invalid-request', 'Wake does not cover the selected window')
        }
        const text = input && this.contextLimit !== undefined
          ? `${action.text}\n\n${input.openingContext.snapshot.text}` : action.text
        if (this.contextLimit !== undefined && Buffer.byteLength(text) > this.contextLimit) {
          throw new EngineError('source-payload-too-large', 'Frozen wake message exceeds its configured byte limit')
        }
        const record: WakeDeliveryRecord = { method: input ? 'seat.wakeFrozen' : 'seat.wake', payload: structuredClone(payload),
          original, action: { ...action, text, operationId: wakeDeliveryId(original.operationId, action.sessionId) }, result: null }
        return [this.effect(record)]
      })
      const record = this.find(payload, authority)
      if (!record) return rejected('unavailable', 'Wake intent is unavailable')
      if ('status' in record) return record
      return await this.finish(record, send)
    } catch (error) {
      if (!(error instanceof EngineError)) throw error
      const result = rejected(error.code, error.message)
      return error.code === 'unavailable' ? { ...result, error: { ...result.error, effectState: 'unknown' } } : result
    }
  }

  /** Replay committed intents before making business queries ready.
   * @param send - Persistent sender whose operation deduplication survives process death.
   * @returns Completion after all outstanding receipts are synchronized.
   */
  async recover(send: WakeSender): Promise<void> {
    for (const record of wakeRecords(this.journal.projection.authorizationDecisions).values()) {
      if (record.result === null) await this.finish(record, send)
    }
  }

  /** Resume an already authorized intent without issuing new authority.
   * @param record - Immutable committed delivery.
   * @param send - Persistent runtime sender.
   * @returns Original first receipt.
   */
  async finish(record: WakeDeliveryRecord, send: WakeSender): Promise<T.WakeSeatResult> {
    if (record.result) return structuredClone(record.result)
    const sent = await send({ ...record.action, mode: 'queue' })
    const result: NonNullable<WakeDeliveryRecord['result']> = { status: record.action.status,
      sessionId: record.action.sessionId, operationId: record.original.operationId, messageId: sent.messageId, title: record.action.title }
    await this.journal.commitAuthorization((view) => {
      const current = wakeRecords(view.authorizationDecisions).get(wakeKey(record))
      if (!current) throw new EngineError('engine-store-corrupt', 'Wake intent disappeared')
      return current.result ? [] : [this.effect({ ...current, result })]
    })
    const committed = wakeRecords(this.journal.projection.authorizationDecisions).get(wakeKey(record))?.result
    if (!committed) throw new EngineError('unavailable', 'Wake receipt requires recovery')
    return structuredClone(committed)
  }

  /** Query only the exact authenticated frozen business identity.
   * @param request - Complete original key and payload digest.
   * @param authority - Independently validated query caller.
   * @returns First receipt, pending state, conflict, or absence.
   */
  query(request: T.NodeWorkChainOperationRequest, authority: T.SeatCallContext): T.NodeWorkChainOperationResult {
    if (authority.principalId !== request.key.principalId || authority.nodeId !== this.journal.nodeId) {
      return rejected('invalid-request', 'Wake query does not match its caller')
    }
    for (const record of wakeRecords(this.journal.projection.authorizationDecisions).values()) {
      if (record.method !== 'seat.wakeFrozen' || !('route' in record.payload) || !record.original.sourceNodeId) continue
      const key: T.NodeWorkChainOperationKey = { method: 'seat.wakeFrozen', operationId: record.original.operationId,
        sourceNodeId: record.original.sourceNodeId, principalId: record.original.principalId,
        sourceId: record.payload.route.sourceId, ownerEpoch: record.payload.route.ownerEpoch }
      if (digest(key) !== digest(request.key)) continue
      let binding = this.journal.projection.opens.get(record.action.sessionId)?.binding
      for (const frame of this.journal.projection.decisions) for (const effect of frame.effects) {
        if (effect.kind === 'seat/binding' && effect.data.sessionId === record.action.sessionId) binding = effect.data
        if ((effect.kind === 'open/created' || effect.kind === 'open/configured')
          && effect.data.sessionId === record.action.sessionId) binding = effect.data.binding
      }
      if (binding?.kind !== 'seat' || binding.nodeId !== authority.nodeId) {
        return rejected('invalid-request', 'Wake query does not match its caller')
      }
      if (record.original.requestDigest !== request.payloadDigest) return rejected('operation-id-conflict', 'Wake operation payload conflicts')
      return record.result ? { status: 'settled', method: 'seat.wakeFrozen', result: structuredClone(record.result) }
        : { status: 'pending', effectState: 'unknown' }
    }
    return { status: 'missing' }
  }

  private effect(record: WakeDeliveryRecord): import('./wake-storage.ts').WakeDeliveryEffect {
    return { kind: 'node-wake/updated', eventId: randomUUID() as T.EngineEventId, operationId: record.original.operationId,
      ...(record.original.seat ? { seat: record.original.seat } : {}), sessionId: record.action.sessionId, data: record }
  }
}
