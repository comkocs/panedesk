/** Explicit completed call evidence for real ledger composition tests. */
import type { Context } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session'
import type { LedgerCallStart, LedgerCallFinish } from '@panedesk/dsh-session-ledger'
import { seat } from './fixtures.ts'

/** Commit a complete conversation call through the public ledger writer.
 * @param ctx - context with the real ledger provider.
 * @param sessionId - exact owning Session.
 * @param id - unique physical call identity.
 * @param costUsd - decimal cost evidence.
 * @param usage - optional complete provider usage evidence.
 */
export async function recordCost(ctx: Context, sessionId: SessionId, id: string, costUsd: string,
  usage?: LedgerCallFinish['usage']): Promise<void> {
  const start: LedgerCallStart = { callId: id as LedgerCallStart['callId'], runId: 'run-cost' as LedgerCallStart['runId'],
    logicalRequestId: id as LedgerCallStart['logicalRequestId'], sessionId, rootSessionId: sessionId,
    nodeId: await ctx.sessionLedger.nodeId(), seat, window: 'seat-a', identitySource: 'settings', accountLabel: 'test',
    attemptIndex: 0, attemptVisibility: 'physical', provider: 'provider-a', modelFamily: 'test', requestedModel: 'model-a',
    purpose: 'conversation', startedAt: Date.now(), cache: { breakReasons: [], cacheMode: 'unknown' },
    cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' }, priceVersion: 'test-v1', priceKey: 'model-a', referencePrice: true }
  const finish: LedgerCallFinish = { callId: start.callId, endedAt: Date.now(), observedAt: Date.now(),
    responseModelReported: 'not-reported', effectiveModel: 'model-a', usageState: 'missing', pricingState: 'missing-usage',
    wallMs: 1, modelInFlightMs: 1, queueMs: 0, backoffMs: 0, waits: [], compactionCount: 0, compactionTimes: [],
    endReason: 'completed', recovered: false, costUsd, ...(usage === undefined ? {} : { usage }) }
  await ctx.sessionLedger.beginCall(start)
  await ctx.sessionLedger.finishCall(finish)
}
