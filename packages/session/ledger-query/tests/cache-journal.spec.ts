import { expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { JournalSessionLedger } from '@panedesk/dsh-session-ledger'
import type { LedgerCallStart, LedgerCallFinish, LedgerEvent } from '@panedesk/dsh-session-ledger'
import { LedgerQueryService } from '../src/index.ts'
import { cacheRemaining, tokenColumns } from '../src/query.ts'

it('queries durable call cache evidence without auxiliary contamination or missing event gaps', async () => {
  const home = await mkdtemp(join(import.meta.dirname, '.cache-query-'))
  const writer = new Context(), reader = new Context()
  try {
    const ledger = new JournalSessionLedger(writer, { dshHome: home })
    const start: LedgerCallStart = {
      sessionId: 'session-a' as LedgerCallStart['sessionId'], rootSessionId: 'session-a' as LedgerCallStart['sessionId'],
      runId: 'run-a' as LedgerCallStart['runId'], nodeId: await ledger.nodeId(), seat: 'seat-a', window: 'window-a',
      identitySource: 'startup', accountLabel: 'unknown', callId: 'call-a' as LedgerCallStart['callId'],
      logicalRequestId: 'request-a' as LedgerCallStart['logicalRequestId'], attemptIndex: 0, attemptVisibility: 'adapter',
      provider: 'provider-a', modelFamily: 'family-a', requestedModel: 'model-a', purpose: 'conversation', startedAt: 100,
      cache: { cacheMode: 'unknown', breakReasons: [] }, cacheWriteTiering: { kind: 'unknown' },
      priceVersion: 'unknown', priceKey: 'model-a', referencePrice: true,
    }
    const finish: LedgerCallFinish = {
      callId: start.callId, endedAt: 200, observedAt: 200, effectiveModel: 'model-a', responseModelReported: 'unobservable',
      usageState: 'complete', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 4, cacheWriteTokens: 6, cacheWriteLongTokens: 2 },
      pricingState: 'missing-price', wallMs: 100, modelInFlightMs: 100, queueMs: 0, backoffMs: 0, waits: [],
      compactionCount: 0, compactionTimes: [], endReason: 'completed', recovered: false,
      cacheWriteTiering: { kind: 'tiered', short: '30m', long: '12h' },
      cache: { cacheMode: 'explicit', breakReasons: [], lastCacheEvidenceAt: 200, ttlSeconds: 1800, downgradeReason: 'non-responses-api' },
    }
    await ledger.beginCall(start)
    await ledger.finishCall(finish)
    const auxiliary = { ...start, callId: 'title-a' as LedgerCallStart['callId'], purpose: 'session-title' as const, startedAt: 300 }
    await ledger.beginCall(auxiliary)
    await ledger.appendEvent({ schemaVersion: 1, eventId: 'cache-title' as LedgerEvent['eventId'],
      nodeId: start.nodeId, runId: start.runId, sessionId: start.sessionId, callId: auxiliary.callId, observedAt: 300,
      kind: 'cache/evidence', evidence: { cacheMode: 'unknown', breakReasons: [] } })
    new JournalSessionLedger(reader, { dshHome: home })
    const query = new LedgerQueryService(reader)
    const snapshot = (await query.query({ sessionId: start.sessionId })).snapshot
    expect(cacheRemaining(snapshot, 1200, { sessionId: start.sessionId })).toMatchObject([
      { sessionId: start.sessionId, state: 'estimated', remainingSeconds: 1799, evidenceAt: 200 },
    ])
    const row = (await reader.sessionLedger.snapshot()).rows.find(item => item.kind === 'call' && item.start.callId === start.callId)
    if (row?.kind !== 'call') throw new Error('Missing durable call')
    expect(tokenColumns(row)).toMatchObject({ cacheWriteShortTokens: 4, cacheWriteLongTokens: 2,
      cacheWriteTiering: { kind: 'tiered', short: '30m', long: '12h' } })
  } finally {
    await reader.fiber.dispose()
    await writer.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
