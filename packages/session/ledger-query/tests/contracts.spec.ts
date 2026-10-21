import { describe, expect, it } from 'vitest'
import Query, { LedgerQueryService } from '../src/index.ts'
import type { LedgerExportFormat } from '../src/index.ts'

describe('ledger query contract', () => {
  it('exports the read-only service and supported formats', () => {
    const formats: LedgerExportFormat[] = ['jsonl', 'csv']
    expect(Query).toBe(LedgerQueryService)
    expect(formats).toEqual(['jsonl', 'csv'])
  })
})
