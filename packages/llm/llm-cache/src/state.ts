/** Cache evidence folding; dispatch alone never refreshes a retention estimate. */
import type { LedgerCacheEvidence, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import type { CacheRemaining } from './types.ts'

/** Recover the newest durable cache observation for a session.
 * @param snapshot - ledger-filtered session snapshot.
 * @returns latest evidence, or undefined when no evidence was recorded.
 */
export function foldCacheState(snapshot: LedgerSnapshot): LedgerCacheEvidence | undefined {
  let latest: LedgerCacheEvidence | undefined
  let observedAt = -Infinity
  for (const row of snapshot.rows) {
    if (row.kind !== 'event' || (row.event.kind !== 'cache/evidence' && row.event.kind !== 'cache/break')) continue
    if (row.event.observedAt >= observedAt) {
      latest = row.event.evidence
      observedAt = row.event.observedAt
    }
  }
  return latest
}

/** Estimate remaining seconds using only observed cache reads or writes.
 * @param evidence - durable evidence; absence means unknown, not a new TTL.
 * @param now - system wall timestamp in milliseconds.
 * @returns labelled estimate, automatic, disabled, or unknown.
 */
export function cacheRemaining(evidence: LedgerCacheEvidence | undefined, now: number): CacheRemaining {
  if (evidence === undefined) return { kind: 'unknown' }
  if (evidence.cacheMode === 'automatic') return { kind: 'automatic' }
  if (evidence.cacheMode === 'disabled') return { kind: 'disabled' }
  if (evidence.ttlSeconds === undefined || evidence.lastCacheEvidenceAt === undefined) return { kind: 'unknown' }
  return {
    kind: 'estimated', evidenceAt: evidence.lastCacheEvidenceAt, ttlSeconds: evidence.ttlSeconds,
    seconds: Math.max(0, (evidence.lastCacheEvidenceAt + evidence.ttlSeconds * 1000 - now) / 1000),
  }
}
