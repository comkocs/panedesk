import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { loadPriceTable, priceUsage } from '../src/pricing.ts'

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
