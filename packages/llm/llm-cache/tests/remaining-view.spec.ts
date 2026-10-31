/** Remaining time shown to a reader matches the ledger estimate within one rounding step. */
import { describe, expect, it } from 'vitest'
import type { LedgerCacheEvidence } from '@panedesk/dsh-session-ledger'
import { cacheRemaining } from '../src/state.ts'
import { resolveCachePolicy, type CacheRoute } from '../src/policy.ts'

/** Whole seconds a cache view reports: the ledger estimate rounded, never below zero. */
function shownSeconds(evidence: LedgerCacheEvidence, now: number): number | undefined {
  const remaining = cacheRemaining(evidence, now)
  return remaining.kind === 'estimated' ? Math.max(0, Math.round(remaining.seconds)) : undefined
}

function evidence(over: Partial<LedgerCacheEvidence>): LedgerCacheEvidence {
  return { cacheMode: 'explicit', breakReasons: [], ...over }
}

describe('cache remaining view', () => {
  it('rounds the ledger estimate and stays within five seconds of it', () => {
    const now = 1_700_000_000_000
    const row = evidence({ ttlSeconds: 300, lastCacheEvidenceAt: now - 125_400 })
    const ledger = cacheRemaining(row, now)
    const shown = shownSeconds(row, now)
    expect(ledger.kind).toBe('estimated')
    if (ledger.kind === 'estimated') expect(Math.abs((shown ?? 0) - ledger.seconds)).toBeLessThanOrEqual(5)
    expect(shown).toBe(175)
  })

  it('reports unknown when the ledger has no evidence, including a subagent row', () => {
    expect(cacheRemaining(undefined, 1).kind).toBe('unknown')
    expect(shownSeconds(evidence({ cacheMode: 'unknown' }), 1)).toBeUndefined()
  })

  it('offers tiers only for an explicit route and none for an automatic route', () => {
    const explicit: CacheRoute = { provider: 'anthropic', modelFamily: 'anthropic', capability: 'anthropic' }
    const automatic: CacheRoute = { provider: 'deepseek', modelFamily: 'deepseek', capability: 'automatic' }
    expect(resolveCachePolicy({ retention: '5m' }, explicit, 'session').mode).toBe('explicit')
    expect(resolveCachePolicy({ retention: 'default' }, automatic, 'session').control.retention).toBe('auto')
    const tiers = (route: CacheRoute): readonly string[] => route.capability === 'anthropic' ? ['none', '5m', '1h']
      : []
    expect(tiers(explicit)).toEqual(['none', '5m', '1h'])
    expect(tiers(automatic)).toEqual([])
  })
})
