/** A process-owned route loses its acknowledgement after the seventh original-key dispatch. */
import { Context } from '@panedesk/cordis'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { SeatEngine } from '../src/engine.ts'
import { CallbackOutbox } from '../src/outbox.ts'
import { SourceRegistry } from '../src/sources.ts'
import { deliverRoutedCallback } from '../src/routed-callback.ts'
import type { CallbackRouterPort } from '../src/routed-callback-types.ts'
import { config, nodeId } from './fixtures.ts'
import { admittedDefinition, persistCallback, callbackIssuer, principalId } from './routed-callback-fixture.ts'

async function main() {
  const [home, stage] = process.argv.slice(2)
  if (!home || (stage !== 'interrupt' && stage !== 'recover')) throw new Error('Invalid process arguments')
  const ctx = new Context(), engine = new SeatEngine(ctx, { home, nodeId, config }, {
    seats: () => ({ resolve: async () => admittedDefinition(), list: async () => ({ status: 'listed', sessions: [],
      unopenedSeats: [], complete: true, snapshotAt: new Date().toISOString() }), close: async () => { throw new Error('Unexpected close') } }),
    ledger: () => undefined,
  })
  await engine.ready()
  const body = stage === 'interrupt' ? await persistCallback(engine) : [...engine.journal.projection.callbacks.values()][0]?.nodeWorkChain
  if (!body) throw new Error('Missing original callback')
  const before = engine.journal.projection.sequence, retained = engine.journal.projection.callbacks.get(body.callback.callbackId)
  let dispatches = 0
  const seen: string[] = [], path = join(home, 'business-effect.json')
  let receipt: T.DeliverSourceCallbackRequest | undefined
  try { receipt = JSON.parse(await readFile(path, 'utf8')) as T.DeliverSourceCallbackRequest }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
  const issuer = callbackIssuer(engine.options.nodeId)
  const router: CallbackRouterPort = { route: async (request) => {
    seen.push(request.method)
    if (request.method === 'chain.operation') {
      const { key, payloadDigest } = request.payload
      if (key.sourceNodeId !== nodeId || key.principalId !== principalId || key.sourceId !== body.route.sourceId
        || key.ownerEpoch !== body.route.ownerEpoch || key.method !== 'source.deliverCallback'
        || key.operationId !== body.route.originalOperationId || key.callbackId !== body.callback.callbackId
        || payloadDigest !== body.payloadDigest || request.targetNodeId !== body.route.sourceOwnerNodeId) {
        throw new Error('Recovery changed the complete original key or target')
      }
      return { method: request.method, status: 'ok', result: receipt
        ? { status: 'settled', method: 'source.deliverCallback', result: { status: 'committed',
          callbackId: receipt.callback.callbackId, payloadDigest: receipt.payloadDigest } } : { status: 'missing' } }
    }
    if (request.method !== 'source.deliverCallback') throw new Error('Unexpected routed operation')
    dispatches++
    if (stage === 'recover' || receipt) throw new Error('Duplicate business effect')
    if (dispatches < 7) return { method: 'source.deliverCallback', status: 'rejected',
      error: { code: 'unavailable', effectState: 'none', retryable: true } }
    receipt = request.payload
    await writeFile(path, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
    process.send?.({ stage: 'interrupt', pid: process.pid, dispatches, frames: engine.journal.projection.sequence - before })
    await new Promise<never>(() => {})
    throw new Error('Unreachable acknowledgement')
  } }
  ctx.provide('nodeWorkChain', issuer); ctx.provide('nodeWorkChainRouter', router)
  const sources = new SourceRegistry(), outbox = new CallbackOutbox(engine.journal, sources,
    { ...config, callbackRetryInitialMs: 1, callbackRetryMaxMs: 1 },
    (request, observation) => deliverRoutedCallback(ctx, engine, request, observation))
  try {
    for (let index = 0; index < (stage === 'interrupt' ? 7 : 1); index++) await outbox.deliver(Date.now() + index)
    await outbox.close()
    process.send?.({ stage: 'recovered', dispatches, seen, original: receipt?.payloadDigest === body.payloadDigest,
      lowerBound: retained?.retrySummary?.attemptsAtLeast, count: retained?.retrySummary?.count,
      phase: engine.journal.projection.callbacks.get(body.callback.callbackId)?.phase,
      frames: engine.journal.projection.sequence - before })
  } finally { await sources.close(); await engine.shutdown(); await ctx.fiber.dispose(); process.disconnect?.() }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; process.disconnect?.() })
