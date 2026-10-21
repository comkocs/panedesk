/** Fake accounting fixtures; these values are not provider prices or observed usage. */
import type { LedgerCallFinish, LedgerCallStart, LedgerEvent, LedgerEventId, LedgerRunStart } from '../src/types.ts'

export const options = { lockTimeoutMs: 3000, lockRetryMs: 5, maxRecordBytes: 1024 * 1024 }
export const callStart: LedgerCallStart = {
  callId: 'call-a' as LedgerCallStart['callId'], runId: 'run-a' as LedgerCallStart['runId'],
  logicalRequestId: 'request-a' as LedgerCallStart['logicalRequestId'],
  sessionId: 'session-a' as LedgerCallStart['sessionId'], rootSessionId: 'session-a' as LedgerCallStart['sessionId'],
  nodeId: 'node-a' as LedgerCallStart['nodeId'], seat: 'seat-a', window: 'window-a', identitySource: 'startup', accountLabel: 'route-a',
  attemptIndex: 0, attemptVisibility: 'physical', provider: 'provider-a', modelFamily: 'family-a', requestedModel: 'model-a', purpose: 'conversation', startedAt: 100,
  cache: { breakReasons: [], cacheMode: 'unknown' }, cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' },
  priceVersion: 'fake-v1', priceKey: 'model-a', referencePrice: true,
}
export const callFinish: LedgerCallFinish = {
  callId: callStart.callId, endedAt: 200, observedAt: 200, responseModelReported: 'not-reported', effectiveModel: 'model-a',
  usageState: 'missing', pricingState: 'missing-usage', wallMs: 100, modelInFlightMs: 100, queueMs: 0, backoffMs: 0, waits: [],
  compactionCount: 0, compactionTimes: [], endReason: 'completed', recovered: false,
}
export const runStart: LedgerRunStart = {
  ...callStart, launchState: 'pending', deliveryPaths: [],
}
export function event(kind: 'call/start' | 'call/end' | 'run/start' = 'call/start'): LedgerEvent {
  const envelope = { schemaVersion: 1 as const, eventId: kind as LedgerEventId, nodeId: callStart.nodeId, runId: callStart.runId, sessionId: callStart.sessionId, callId: callStart.callId, observedAt: kind === 'call/end' ? 200 : 100 }
  if (kind === 'call/end') return { ...envelope, kind, data: { ...callFinish } }
  if (kind === 'run/start') return { ...envelope, kind, data: { ...runStart } }
  return { ...envelope, kind, data: { ...callStart } }
}
