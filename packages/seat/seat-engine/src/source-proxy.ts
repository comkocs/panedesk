/** The source journal reserves complete remote intents before any composition-owned send. */
import { randomUUID } from 'node:crypto'
import type * as T from '@panedesk/dsh-seat'
import type { SeatEngine } from './engine.ts'
import { digest, EngineError } from './journal.ts'
import { rejected } from './triggers.ts'
import { sourceProxyRecords } from './source-proxy-storage.ts'
import type { SourceProxyInputs, SourceProxyPort, SourceProxyRecord, SourceProxyOutcome } from './source-proxy-types.ts'

/** Unknown remote outcomes retain the source reservation and never admit local execution. */
export class SourceProxy {
  private readonly active = new Map<string, Promise<T.NodeWorkChainMethodMap[T.SeatRemoteOpeningMethod]['result']>>()
  private closing = false
  private isClosing(): boolean { return this.closing }
  private chain: Promise<void> = Promise.resolve()
  constructor(private readonly engine: SeatEngine, private readonly port: SourceProxyPort) {}
  /** Route only explicit remote targets; absence preserves the complete legacy path.
   * @param method - Frozen remote method.
   * @param input - Original local action.
   * @param authority - Captured local entry, omitted only for composition-authenticated triggers.
   * @param sourceEvent - Registered external event retained for composition-owned wake preparation.
   * @returns Remote acknowledgement, explicit unknown refusal, or absence for local execution.
   */
  async route<M extends T.SeatRemoteOpeningMethod>(method: M, input: SourceProxyInputs[M],
    authority?: T.SeatCallContext, sourceEvent?: T.TriggerEnvelope): Promise<T.NodeWorkChainMethodMap[M]['result'] | undefined> {
    if (this.isClosing()) return rejected('unavailable', 'Source proxy is closing')
    const target = 'nodeId' in input ? input.nodeId : await this.port.target(input.seat)
    if (target === undefined || target === this.engine.options.nodeId) return undefined
    await this.engine.ready()
    if (this.isClosing()) return rejected('unavailable', 'Source proxy is closing')
    const key = digest([method, input, authority?.principalId ?? null])
    const active = this.active.get(key)
    if (active) return active
    const snapshot = structuredClone(input)
    const event = sourceEvent ? structuredClone(sourceEvent) : undefined
    const work = this.chain.then(() => this.forward(method, snapshot, target, authority, event))
    this.chain = work.then(() => undefined, () => undefined)
    this.active.set(key, work)
    try { return await work } finally { this.active.delete(key) }
  }
  private unknown(): T.SeatRejected {
    const result = rejected('unavailable', 'Remote operation outcome is unknown; retain the original operation and reservation')
    return { ...result, error: { ...result.error, effectState: 'unknown', retryable: true } }
  }
  private result<M extends T.SeatRemoteOpeningMethod>(outcome: SourceProxyOutcome<M>): T.NodeWorkChainMethodMap[M]['result'] {
    return outcome.status === 'unknown' ? this.unknown() : outcome.result
  }
  private async forward<M extends T.SeatRemoteOpeningMethod>(method: M, input: SourceProxyInputs[M], targetNodeId: T.SeatNodeId,
    authority?: T.SeatCallContext, sourceEvent?: T.TriggerEnvelope): Promise<T.NodeWorkChainMethodMap[M]['result']> {
    const inputDigest = digest(input)
    const records = sourceProxyRecords(this.engine.journal.projection.authorizationDecisions)
    const retained = [...records.values()].find(record => record.method === method
      && (authority ? record.operationKey.principalId === authority.principalId : true)
      && ('operationId' in input ? record.operationKey.operationId === input.operationId
        : 'sourceId' in record.input && record.input.sourceId === input.sourceId
          && (input.eventId ? record.input.eventId === input.eventId : record.input.triggerId === input.triggerId)))
    if (retained) {
      if (retained.inputDigest !== inputDigest || retained.targetNodeId !== targetNodeId) {
        return rejected('operation-id-conflict', 'Remote operation changed its original input or target')
      }
      if (retained.outcome.status === 'unknown' && this.port.reconcile) {
        let outcome: SourceProxyOutcome<M>
        try { outcome = await this.port.reconcile(structuredClone(retained)) }
        catch (_error) { return this.unknown() } // Failed queries retain the original reservation.
        return this.settle(retained, outcome)
      }
      return this.result(retained.outcome)
    }
    const prepared = await this.port.prepare({ method, input, targetNodeId, ...(authority ? { authority } : {}),
      ...(sourceEvent ? { sourceEvent } : {}) })
    if ('status' in prepared) return prepared
    const { payload, original } = prepared, operationId = payload.route.originalOperationId
    if (authority && (original !== authority.authorization || authority.principalId !== original.fact.principalId
      || authority.nodeId !== this.engine.options.nodeId)) return rejected('unauthorized', 'Source authority differs from the local entry')
    const record = { method, input, inputDigest, targetNodeId, payload, payloadDigest: digest(payload), original: original.fact,
      operationKey: { sourceNodeId: this.engine.options.nodeId, principalId: original.fact.principalId,
        sourceId: payload.route.sourceId, ownerEpoch: payload.route.ownerEpoch, method, operationId },
      outcome: { status: 'unknown' as const } } as SourceProxyRecord
    try {
      await this.engine.journal.commitAuthorization(() => {
        const fact = this.engine.authorizationIssuers.verify(original, { operationId, requestDigest: inputDigest,
          ...(original.fact.callId ? { callId: original.fact.callId } : {}),
          ...(original.fact.rootCallId ? { rootCallId: original.fact.rootCallId } : {}) }, this.engine.options.nodeId)
        if (fact.kind === 'node-delegation' || fact.decision !== 'allowed') throw new EngineError('unauthorized', 'Source authority cannot delegate')
        return [{ kind: 'node-source/updated', eventId: randomUUID() as T.EngineEventId, operationId, seat: input.seat, data: record }]
      })
    } catch (error) {
      if (!(error instanceof EngineError)) throw error
      return error.code === 'unavailable' ? this.unknown() : rejected(error.code, error.message)
    }
    let outcome: SourceProxyOutcome<M>
    try { outcome = await this.port.send({ method, targetNodeId, operationId, payload: structuredClone(payload), original }) }
    catch (_error) { return this.unknown() } // Transport throws cannot establish absence of a remote effect.
    return this.settle(record, outcome)
  }
  private async settle<M extends T.SeatRemoteOpeningMethod>(record: SourceProxyRecord,
    supplied: SourceProxyOutcome<M>): Promise<T.NodeWorkChainMethodMap[M]['result']> {
    let outcome = supplied
    const operationId = record.operationKey.operationId
    if (outcome.status === 'rejected' && outcome.result.error.effectState !== 'none') outcome = { status: 'unknown' }
    if (outcome.status === 'committed' && outcome.result.status === 'rejected') {
      outcome = outcome.result.error.effectState === 'none' ? { status: 'rejected', result: outcome.result } : { status: 'unknown' }
    }
    try {
      await this.engine.journal.commitAuthorization(() => [{ kind: 'node-source/updated', eventId: randomUUID() as T.EngineEventId,
        operationId, seat: record.input.seat, data: { ...record, outcome } as SourceProxyRecord }])
    } catch (_error) { return this.unknown() } // A result not durably recorded remains unknown to the source.
    return this.result(outcome)
  }
  /** Stop new calls and drain accepted sends before closing the shared journal. */
  async close(): Promise<void> { this.closing = true; await Promise.allSettled([...this.active.values()]) }
}
