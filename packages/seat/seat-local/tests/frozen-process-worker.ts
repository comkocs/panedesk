/** Test worker owns one complete Loader process and deterministic journal write barriers. */
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { processFixture, methods } from './frozen-process-fixture.ts'
import { processInput } from './frozen-process-input.ts'
import type * as T from '@panedesk/dsh-seat'

async function main() {
  const [root, selected, stage] = process.argv.slice(2)
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
    await new Promise<never>(() => {})
  } finally { await h.close(); process.disconnect?.() }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; process.disconnect?.() })
