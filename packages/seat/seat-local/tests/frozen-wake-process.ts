/** Real persistent delivery is retained across the frozen worker's parent-owned SIGKILL points. */
import { frozenHost } from './frozen-fixture.ts'
import type * as T from '@panedesk/dsh-seat'
import { digest } from '../src/store.ts'

/** Run one wake worker against the parent-retained home.
 * @param root - Persistent home reused after process death.
 * @param stage - Parent-selected barrier or recovery.
 */
export async function wakeProcess(root: string, stage: string): Promise<void> {
  const { h, registry, request, authorize } = await frozenHost(root)
  try {
    const operationId = 'process-wake-delivery' as T.SeatOperationId, base = request(operationId)
    const payload: T.WakeFrozenSeatRequest = { ...base, request: { seat: base.request.seat, operationId } }
    const query: T.NodeWorkChainOperationRequest = { key: { method: 'seat.wakeFrozen', operationId,
      sourceNodeId: 'sending-node' as T.SeatNodeId, principalId: 'remote-principal' as T.SeatPrincipalId,
      sourceId: payload.route.sourceId, ownerEpoch: payload.route.ownerEpoch }, payloadDigest: digest(payload) }
    if (stage === 'recover') {
      await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
      const result = await registry.query(query, await authorize(query, 'query-delivery' as T.SeatOperationId))
      const replay = await h.ctx.get('seats')!.withAuthority(await authorize(payload, operationId)).wakeFrozen!(payload)
      const messages = await h.ctx.get('messageDelivery')!.list({ messageClasses: ['handoff'], includeTerminal: true })
      process.send?.({ kind: 'wake-recovered', result, replay, count: messages.items.length, complete: messages.complete })
      return
    }
    await registry.ready(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'])
    const definition = await h.seats.resolve(h.definition.seat)
    if ('status' in definition) throw new Error('Expected definition')
    const catalog = await h.seats.definitions({})
    await h.seats.save({ definition: { ...definition, wakeTemplate: { kind: 'text', text: 'Persistent wake' } },
      expectedRevision: catalog.revision, operationId: 'process-wake-template' as T.SeatOperationId })
    const opened = await h.seats.open({ seat: definition.seat, operationId: 'process-existing-window' as T.SeatOperationId,
      origin: 'manual', openingMode: 'prefill' })
    if (opened.status !== 'prefilled') throw new Error('Expected prefilled window')
    const pause = async (point: string, result?: object): Promise<never> => {
      process.send?.({ kind: 'wake-barrier', point, pid: process.pid, ...(result ? { result } : {}) })
      return new Promise<never>(() => {})
    }
    const delivery = h.ctx.get('messageDelivery')!, send = delivery.send.bind(delivery)
    delivery.send = async (input) => {
      if (stage === 'intent') await pause(stage)
      const sent = await send(input)
      if (stage === 'sent') await pause(stage, sent)
      return sent
    }
    const commit = h.engine.journal.commitAuthorization.bind(h.engine.journal)
    h.engine.journal.commitAuthorization = async (build, revision, metadata) => {
      if (stage === 'receipt') {
        const effects = build(h.engine.journal.projection)
        if (effects.some(effect => effect.kind === 'node-wake/updated' && effect.data.result !== null)) {
          const record = effects.find(effect => effect.kind === 'node-wake/updated')
          await pause(stage, record?.kind === 'node-wake/updated' ? record.data.result ?? undefined : undefined)
        }
      }
      return commit(build, revision, metadata)
    }
    await h.ctx.get('seats')!.withAuthority(await authorize(payload, operationId)).wakeFrozen!(payload)
    throw new Error('Wake did not reach the requested barrier')
  } finally { await h.close(); process.disconnect?.() }
}
