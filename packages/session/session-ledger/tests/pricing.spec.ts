import { describe, expect, it } from 'vitest'
import { loadPriceTable, priceUsage, recomputeUsage, tokenColumns } from '../src/pricing.ts'
import type { LedgerPriceEntry, LedgerPriceUsageRequest } from '../src/types.ts'

const fake: LedgerPriceEntry = {
  version: 'fake-v1', sourceUrls: ['https://example.invalid/fake-prices'], retrievedOn: '2026-01-01', reference: true,
  modelFamily: 'family-a', modelKey: 'model-a', currency: 'USD', holidaysUnmodeled: true,
  prices: { input: '2', cacheRead: '0.2', cacheWrite: { '5m': '3', '1h': '4', untiered: '3' }, output: '6' },
}
const request: LedgerPriceUsageRequest = {
  usage: { inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 1000, cacheWriteLongTokens: 400, outputTokens: 500 },
  usageState: 'complete', tiering: { kind: 'tiered', short: '5m', long: '1h' }, startedAt: Date.parse('2026-01-05T10:00:00Z'), entry: fake,
}

describe('fake reference pricing', () => {
  it('exports five disjoint columns and agrees with independent arithmetic', () => {
    expect(tokenColumns(request)).toMatchObject({
      inputTokens: 1000, cacheReadTokens: 2000, cacheWriteShortTokens: 600, cacheWriteLongTokens: 400, outputTokens: 500,
    })
    expect(priceUsage(request)).toEqual({ state: 'priced', priceVersion: 'fake-v1', reference: true, costUsd: '0.0088' })
    expect(Math.abs(Number(priceUsage(request).costUsd) - recomputeUsage(request)!)).toBeLessThan(1e-6)
  })
  it('never counts untiered writes as short writes or charges their long subset twice', () => {
    const untiered = { ...request, tiering: { kind: 'untiered' as const } }
    expect(tokenColumns(untiered).cacheWriteShortTokens).toBeUndefined()
    expect(priceUsage(untiered).costUsd).toBe('0.0084')
  })
  it('keeps missing usage, partial counters, unknown tiers, and missing prices unknown', () => {
    expect(priceUsage({ ...request, usage: undefined }).state).toBe('missing-usage')
    expect(priceUsage({ ...request, usageState: 'partial' }).costUsd).toBeUndefined()
    expect(priceUsage({ ...request, entry: undefined }).state).toBe('missing-price')
    expect(priceUsage({ ...request, usage: { inputTokens: 1, outputTokens: 1 } }).state).toBe('partial-usage')
    expect(priceUsage({ ...request, tiering: { kind: 'unknown' } }).state).toBe('missing-price')
    expect(priceUsage({ ...request, usage: { ...request.usage!, cacheWriteLongTokens: 1001 } }).state).toBe('partial-usage')
  })
  it('replaces whole-call prices above the all-input threshold, including reads and writes', () => {
    const entry = { ...fake, contextRule: { counting: 'all-input-including-cache-read-write' as const, thresholdTokens: 3999, prices: { ...fake.prices, input: '10' } } }
    expect(priceUsage({ ...request, entry }).costUsd).toBe('0.0168')
    entry.contextRule.thresholdTokens = 4000
    expect(priceUsage({ ...request, entry }).costUsd).toBe('0.0088')
  })
  it('selects UTC weekdays and half-open time windows and separately prices storage', () => {
    const entry: LedgerPriceEntry = { ...fake, timeRules: [{ weekdays: [1], fromHour: 10, toHour: 11, prices: { ...fake.prices, output: '2' } }] }
    expect(priceUsage({ ...request, entry }).costUsd).toBe('0.0068')
    expect(priceUsage({ ...request, entry, startedAt: Date.parse('2026-01-05T11:00:00Z') }).costUsd).toBe('0.0088')
    const storage = { ...fake, prices: { ...fake.prices, cacheStoragePerMillionTokenHour: '0.1' } }
    expect(priceUsage({ ...request, entry: storage }).state).toBe('partial-usage')
    expect(priceUsage({ ...request, entry: storage, cacheStorageTokenHours: '1000.5' }).costUsd).toBe('0.00890005')
  })
  it('validates source, version, date, decimal units, and overlapping windows at load', () => {
    const table = { ...fake, entries: [fake] }
    expect(loadPriceTable(JSON.stringify(table)).entries).toHaveLength(1)
    for (const invalid of [
      { ...table, reference: false }, { ...table, sourceUrls: [] }, { ...table, retrievedOn: '2026-02-30' },
      { ...table, entries: [{ ...fake, version: 'other' }] },
      { ...table, entries: [{ ...fake, prices: { ...fake.prices, input: '-1' } }] },
      { ...table, entries: [fake, fake] },
      { ...table, entries: [{ ...fake, timeRules: [
        { weekdays: [1], fromHour: 1, toHour: 3, prices: fake.prices },
        { weekdays: [1], fromHour: 2, toHour: 4, prices: fake.prices },
      ] }] },
    ]) expect(() => loadPriceTable(JSON.stringify(invalid))).toThrow()
  })
  it('retains tiny decimal amounts rather than rounding them to zero', () => {
    const entry = { ...fake, prices: { ...fake.prices, input: '0.000000001' } }
    expect(priceUsage({ ...request, entry, usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWriteLongTokens: 0 } }).costUsd).toBe('0.000000000000001')
  })
})
