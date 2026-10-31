/** Test worker owns one complete Loader process and deterministic journal write barriers. */
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { processFixture, methods } from './frozen-process-fixture.ts'
import { processInput } from './frozen-process-input.ts'
import type * as T from '@panedesk/dsh-seat'
import type { NodeWireRequest } from '@panedesk/dsh-node-link'
import { digest } from '@panedesk/dsh-seat-engine'
import { sender, principalId } from './frozen-process-fixture.ts'

/** Hold the event loop until the fixture kills this worker.
 * A message-free IPC channel stays unref'd, so drained fixture handles would otherwise let it exit on its own. */
function holdUntilKilled(): void { setInterval(() => {}, 2 ** 31 - 1) }

async function batch(root: string, stage: string) {
  const h = await processFixture(root)
  try {
    await h.registry.ready(methods)
    const seats = h.ctx.get('seats')!.withAuthority({ principalId, nodeId: 'node-a' as T.SeatNodeId, origin: 'manual' })
    const catalog = await seats.definitions({}), seat = 'seat-b' as T.SeatName
    if (!catalog.definitions.some(item => item.seat === seat)) {
      await seats.save({ definition: { ...h.definition, seat }, expectedRevision: catalog.revision,
        operationId: 'second-seat' as T.SeatOperationId })
    }
    const payload: T.OpenSeatBatchRequest = { seats: [h.definition.seat, seat], origin: 'remote', operationId: 'batch' as T.SeatOperationId }
    const authority = await h.authorize(payload, payload.operationId, true), grant = authority.authorization
    const request: Extract<NodeWireRequest, { method: 'seat.openBatch' }> = { version: 'node-link/v1', requestId: 'batch-request' as NodeWireRequest['requestId'],
      method: 'seat.openBatch', sourceNodeId: sender, targetNodeId: authority.nodeId, operationId: payload.operationId,
      payload, payloadDigest: digest(payload), deadline: '2099-01-01T00:00:00.000Z', hop: 1,
      delegation: { kind: 'node-delegation', hop: 1, principalId, authorizationRef: grant.fact.authorizationId,
        sourceNodeId: sender, targetNodeId: authority.nodeId, operationId: payload.operationId, requestDigest: digest(payload),
        taskIds: [], expiresAt: '2099-01-01T00:00:00.000Z' } }
    let first: T.OpenSeatResult | undefined
    if (stage === 'partial') {
      const originalMember = h.engine.openBatchMember.bind(h.engine)
      h.engine.openBatchMember = async (...args) => {
        const result = await originalMember(...args)
        first ??= result
        return result
      }
      const probe = await open(join(root, 'batch-probe'), 'wx', 0o600)
      const prototype = Object.getPrototypeOf(probe) as { writeFile: typeof probe.writeFile }
      await probe.close()
      const original = prototype.writeFile
      let count = 0
      prototype.writeFile = async function (this: FileHandle, data, options) {
        if (typeof data === 'string' && data.includes('node-batch/accepted') && ++count === 2) {
          const bytes = Buffer.from(data)
          await original.call(this, bytes.subarray(0, Math.floor(bytes.length / 2)), options)
          await this.sync()
          process.send?.({ kind: 'partial-batch', first, pid: process.pid })
          holdUntilKilled()
          await new Promise<never>(() => {})
        }
        return original.call(this, data, options)
      }
    }
    const before = h.engine.journal.projection.authorizationDecisions.filter(frame => frame.effects.some(effect => effect.kind === 'node-batch/accepted')).length
    const result = await h.ctx.get('nodeAuthorizedLocalAdmission')!.execute(request, grant)
    process.send?.({ kind: 'batch-recovered', before, result, members: h.engine.journal.projection.authorizationDecisions
      .filter(frame => frame.effects.some(effect => effect.kind === 'node-batch/accepted')).length })
  } finally { await h.close(); process.disconnect?.() }
}

async function main() {
  const [root, selected, stage] = process.argv.slice(2)
  if (root && selected === 'seat.wakeDelivery' && stage) {
    const { wakeProcess } = await import('./frozen-wake-process.ts')
    return wakeProcess(root, stage)
  }
  if (root && selected === 'seat.openBatch' && (stage === 'partial' || stage === 'recover')) return batch(root, stage)
  const method = methods.find(value => value === selected)
  if (!root || !method || !['write', 'partial', 'recover'].includes(stage ?? '')) throw new Error('Invalid worker arguments')
  const h = await processFixture(root), input = processInput(method, h.definition)
  try {
    const authority = await h.authorize(input.query, 'query' as T.SeatOperationId)
    const before = await h.registry.query(input.query, authority)
    await h.registry.ready(methods)
    if (stage === 'recover') {
      const result = await h.registry.query(input.query, authority)
      const conflict = await h.registry.query({ ...input.query, payloadDigest: 'different' as T.SeatDigest },
        await h.authorize({ ...input.query, payloadDigest: 'different' as T.SeatDigest }, 'conflict' as T.SeatOperationId))
      const variants = []
      for (const key of ['sourceId', 'ownerEpoch', 'operationId', 'callbackId'] as const) {
        const query: T.NodeWorkChainOperationRequest = { ...input.query, key: { ...input.query.key, [key]: 'different' } }
        variants.push(await h.registry.query(query, await h.authorize(query, `query:${key}` as T.SeatOperationId)))
      }
      process.send?.({ kind: 'recovered', before, result, conflict, variants,
        routes: h.engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
          .filter(effect => effect.kind === 'node-route/accepted').length })
      return
    }
    if (stage === 'partial') {
      const probe = await open(join(root, 'write-probe'), 'wx', 0o600)
      const prototype = Object.getPrototypeOf(probe) as { writeFile: typeof probe.writeFile }
      await probe.close()
      const original = prototype.writeFile
      prototype.writeFile = async function (this: FileHandle, data, options) {
        if (typeof data === 'string' && data.includes('node-route/accepted')) {
          const bytes = Buffer.from(data)
          await original.call(this, bytes.subarray(0, Math.floor(bytes.length / 2)), options)
          await this.sync()
          process.send?.({ kind: 'partial', pid: process.pid })
          holdUntilKilled()
          await new Promise<never>(() => {})
        }
        return original.call(this, data, options)
      }
    }
    const grant = await h.authorize(input.payload, input.operationId)
    const seats = h.ctx.get('seats')!.withAuthority(grant)
    const result = method === 'engine.acceptFrozen'
      ? await h.engine.acceptFrozen(input.payload as T.AcceptFrozenTriggerRequest, grant)
      : method === 'seat.openFrozen' ? await seats.openFrozen!(input.payload as T.OpenFrozenSeatRequest)
        : await seats.wakeFrozen!(input.payload as T.WakeFrozenSeatRequest)
    process.send?.({ kind: 'accepted', before, result, pid: process.pid })
    holdUntilKilled()
    await new Promise<never>(() => {})
  } finally { await h.close(); process.disconnect?.() }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; process.disconnect?.() })
