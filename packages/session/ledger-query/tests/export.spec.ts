import { describe, expect, it } from 'vitest'
import type { LedgerCall, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { mergeLedger, parseLedgerExport, serializeLedger, verifyLedger } from '../src/export.ts'

function call(id: string, node = 'node-a'): LedgerCall {
  return { kind: 'call', start: { callId: id as LedgerCall['start']['callId'], runId: 'run-a' as LedgerCall['start']['runId'],
    logicalRequestId: 'request-a' as LedgerCall['start']['logicalRequestId'], sessionId: 'session-a' as LedgerCall['start']['sessionId'],
    rootSessionId: 'session-a' as LedgerCall['start']['rootSessionId'], nodeId: node as LedgerCall['start']['nodeId'],
    seat: '=SUM(A1)', window: '+cmd', taskId: '@task', identitySource: 'startup', accountLabel: 'unknown',
    startedAt: 100, attemptIndex: 0, attemptVisibility: 'physical', provider: 'provider-a', modelFamily: 'family-a', requestedModel: '-model',
    purpose: 'conversation', cache: { cacheMode: 'unknown', breakReasons: [] }, cacheWriteTiering: { kind: 'untiered' },
    priceVersion: 'fixture-v1', priceKey: 'model-a', referencePrice: true } }
}
function snapshot(rows: LedgerSnapshot['rows'], node = 'node-a'): LedgerSnapshot {
  return { asOf: 1000, complete: true, rows, watermarks: { [node]: 'watermark-a' as LedgerSnapshot['watermarks'][string] } }
}
describe('public ledger export and merge', () => {
  it('roundtrips raw numeric precision and absent usage without inventing zeros', () => {
    const row = call('a')
    const source = snapshot([row])
    const encoded = serializeLedger(source, 'jsonl')
    expect(parseLedgerExport(encoded)).toEqual(source)
    expect(encoded).not.toContain('costUsd')
    expect(encoded).not.toContain('inputTokens')
    expect(verifyLedger(source, source.asOf, 10000)).toMatchObject({ valid: true, recomputed: { tokens: 0, unknownCostCalls: 1 } })
  })
  it('neutralizes formula-leading and control-prefixed cells and escapes quotes', () => {
    const a = call('a'), b = call('b')
    b.start.seat = '\t=1'; b.start.window = ' \r+1'; b.start.taskId = 'task,"quoted"\nline'
    const csv = serializeLedger(snapshot([a, b]), 'csv')
    for (const text of ["'=SUM(A1)", "'+cmd", "'@task", "'-model", "'\t=1", "' \r+1"]) expect(csv).toContain(text)
    expect(csv).toContain('task,""quoted""\nline')
    expect(csv).toContain('cacheWriteShortTokens')
    expect(csv).toContain('missing-usage')
  })
  it('merges two nodes by session and call identity, excluding every conflicting variant', () => {
    const a = call('a'), b = call('b', 'node-b'), conflict = structuredClone(a)
    conflict.start.requestedModel = 'model-b'
    const good = mergeLedger([snapshot([a]), snapshot([a, b], 'node-b')])
    expect(good.snapshot.rows).toHaveLength(2)
    expect(good.sessions['session-a']).toHaveLength(2)
    expect(good.conflicts).toEqual([])
    const bad = mergeLedger([snapshot([a]), snapshot([conflict, b], 'node-b')])
    expect(bad.snapshot.rows).toEqual([b])
    expect(bad.conflicts).toHaveLength(1)
    expect(bad.conflicts[0]!.key).toBe('call:a')
    expect(bad.conflicts[0]!.variants).toEqual(expect.arrayContaining([a, conflict]))
    expect(bad.snapshot.complete).toBe(false)
    expect(mergeLedger([snapshot([conflict, b], 'node-b'), snapshot([a])])).toEqual(bad)
  })
  it('rejects incomplete exports, invalid rows and impossible long-write counts', () => {
    const text = serializeLedger(snapshot([call('a')]), 'jsonl')
    expect(() => parseLedgerExport(text.trimEnd())).toThrow('Incomplete')
    expect(() => parseLedgerExport('{"kind":"snapshot"}\n')).toThrow('header')
    expect(() => parseLedgerExport(text.replace('"startedAt":100', '"startedAt":"100"'))).toThrow('row')
    expect(() => parseLedgerExport(text.replace('"cacheMode":"unknown"', '"cacheMode":"fabricated"'))).toThrow('row')
    expect(() => parseLedgerExport(text.replace('"kind":"call"', '"kind":"unknown"'))).toThrow('row')
  })
})
