import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { loadPriceTable, priceUsage } from '../src/pricing.ts'

it('uses reference whole-context thresholds and UTC peak boundaries', async () => {
  const table = loadPriceTable(await readFile(new URL('../prices/reference-v1.json', import.meta.url), 'utf8'))
  const amount = (model: string, input: number, at: string, read = 0) => priceUsage({
    entry: table.entries.find(entry => entry.modelKey === model), startedAt: Date.parse(at), usageState: 'complete',
    tiering: { kind: 'untiered' }, usage: { inputTokens: input, outputTokens: 0, cacheReadTokens: read, cacheWriteTokens: 0 },
  }).costUsd
  expect(amount('grok-4.7', 200000, '2026-10-22T00:00:00Z')).toBe('0.4')
  expect(amount('grok-4.7', 200000, '2026-10-22T00:00:00Z', 1)).toBe('0.800001')
  expect(amount('gpt-6-luna', 272001, '2026-10-22T00:00:00Z')).toBe('0.0544002')
  expect(amount('claude-haiku-5-5', 100001, '2026-10-22T00:00:00Z')).toBe('0.0500005')
  expect(amount('deepseek-flash', 1000, '2026-10-22T00:59:59Z')).toBe('0.00015')
  expect(amount('deepseek-flash', 1000, '2026-10-22T01:00:00Z')).toBe('0.0003')
  expect(amount('deepseek-flash', 1000, '2026-10-22T04:00:00Z')).toBe('0.00015')
  expect(amount('deepseek-flash', 1000, '2026-10-24T01:00:00Z')).toBe('0.00015')
})

it('loads the reference table and matches a hand calculation for every provider family', async () => {
  const table = loadPriceTable(await readFile(new URL('../prices/reference-v1.json', import.meta.url), 'utf8'))
  expect(table.entries).toHaveLength(14)
  const cases = [
    ['gpt-6-astra', '0.062375', { kind: 'tiered', short: '30m', long: '12h' }],
    ['claude-fable-5-1', '0.06175', { kind: 'tiered', short: '5m', long: '1h' }],
    ['deepseek-flash', '0.0007515', { kind: 'untiered' }],
    ['glm-5.3', '0.00593', { kind: 'untiered' }],
    ['grok-4.7', '0.00825', { kind: 'untiered' }],
  ] as const
  for (const [model, expected, tiering] of cases) {
    const entry = table.entries.find(item => item.modelKey === model)!
    expect(priceUsage({ entry, startedAt: Date.parse('2026-10-24T12:00:00Z'), usageState: 'complete', tiering,
      usage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 100, cacheWriteLongTokens: 50 },
      cacheStorageTokenHours: '0',
    })).toMatchObject({ state: 'priced', costUsd: expected, priceVersion: 'reference-v1', reference: true })
  }
})
