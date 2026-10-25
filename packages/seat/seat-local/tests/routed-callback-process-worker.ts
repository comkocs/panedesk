/** Process barriers retain the original engine callback and owner receipt independently. */
import { Context } from '@panedesk/cordis'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { SeatEngine } from '@panedesk/dsh-seat-engine/src/engine.ts'
import { CallbackOutbox } from '@panedesk/dsh-seat-engine/src/outbox.ts'
import { SourceRegistry } from '@panedesk/dsh-seat-engine/src/sources.ts'
import { deliverRoutedCallback } from '@panedesk/dsh-seat-engine/src/routed-callback.ts'
import { config, nodeId } from '../../seat-engine/tests/fixtures.ts'
import { admittedDefinition, loopback, persistCallback, response, services } from './routed-callback-fixture.ts'

async function main() {
  const [home, stage] = process.argv.slice(2)
  if (!home || !['intent', 'sent', 'recover'].includes(stage ?? '')) throw new Error('Invalid process arguments')
  const ctx = new Context(), engine = new SeatEngine(ctx, { home, nodeId, config }, {
    seats: () => ({ resolve: async () => admittedDefinition(), list: async () => ({ status: 'listed', sessions: [],
      unopenedSeats: [], complete: true, snapshotAt: new Date().toISOString() }), close: async () => { throw new Error('Unexpected close') } }),
    ledger: () => undefined })
  await engine.ready()
  const ownerPath = join(home, 'owner-result.json'), inputs: unknown[] = []
  let retained: T.DeliverSourceCallbackRequest | undefined
  try { retained = JSON.parse(await readFile(ownerPath, 'utf8')) as T.DeliverSourceCallbackRequest }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
  const link = await loopback(home, nodeId, async (request) => {
    inputs.push(request.method)
    if (request.method === 'chain.operation') return response(request, retained ? { status: 'settled', method: 'source.deliverCallback',
      result: { status: 'committed', callbackId: retained.callback.callbackId, payloadDigest: retained.payloadDigest } } : { status: 'missing' })
    if (request.method !== 'source.deliverCallback') throw new Error('Unexpected business method')
    if (retained) throw new Error('Duplicate owner business write')
    retained = request.payload
    await writeFile(ownerPath, JSON.stringify(retained), { flag: 'wx' })
    if (stage === 'sent') {
      process.send?.({ stage, pid: process.pid, body: retained })
      await new Promise<never>(() => {})
    }
    return response(request, { status: 'committed', callbackId: retained.callback.callbackId, payloadDigest: retained.payloadDigest })
  })
  ctx.provide('nodeWorkChain', services(() => engine, [])); ctx.provide('nodeWorkChainRouter', link.router)
  const sources = new SourceRegistry(), outbox = new CallbackOutbox(engine.journal, sources, config,
    body => deliverRoutedCallback(ctx, engine, body))
  try {
    const body = stage === 'recover' ? [...engine.journal.projection.callbacks.values()][0]?.nodeWorkChain : await persistCallback(engine)
    if (!body) throw new Error('Missing callback')
    if (stage === 'intent') {
      process.send?.({ stage, pid: process.pid, body })
      await new Promise<never>(() => {})
    }
    await outbox.deliver()
    if (stage === 'sent') await new Promise<never>(() => {})
    process.send?.({ stage: 'recovered', body, owner: retained, inputs,
      phase: engine.journal.projection.callbacks.get(body.callback.callbackId)?.phase })
  } finally {
    await outbox.close(); await sources.close(); await link.close()
    await engine.shutdown(); await ctx.fiber.dispose(); process.disconnect?.()
  }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; process.disconnect?.() })
