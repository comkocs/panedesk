import { describe, expect, it } from 'vitest'
import Ledger, { JournalSessionLedger as SessionLedger } from '../src/index.ts'
import type { LedgerEndReason } from '../src/index.ts'

describe('ledger service contract', () => {
  it('exports the service definition and all terminal reasons', () => {
    const reasons: LedgerEndReason[] = ['completed', 'timeout', 'killed', 'error', 'cancelled']
    expect(Ledger).toBe(SessionLedger)
    expect(reasons).toHaveLength(5)
  })
})
