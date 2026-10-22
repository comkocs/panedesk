/** Bounded maintenance scheduling without changing the ordinary conversation surface. */
import type { LedgerCacheEvidence } from '@panedesk/dsh-session-ledger'
import type { KeepalivePolicy } from './types.ts'

/** Compute a bounded next maintenance time; no TTL evidence means no timer.
 * @param evidence - observed cache state for the stable prefix.
 * @param policy - explicit opt-in and timing budgets.
 * @param now - current wall time.
 * @param lastAttempt - last maintenance start, even when it failed; absent before the first attempt.
 * @returns next wall timestamp, or undefined when maintenance is disabled or unsupported.
 */
export function scheduleKeepalive(
  evidence: LedgerCacheEvidence | undefined,
  policy: KeepalivePolicy,
  now: number,
  lastAttempt?: number,
): number | undefined {
  if (!policy.enabled || evidence?.cacheMode !== 'explicit' || evidence.ttlSeconds === undefined || evidence.lastCacheEvidenceAt === undefined) return
  const interval = policy.minimumIntervalSeconds * 1000
  const ttl = evidence.ttlSeconds * 1000
  const lead = Math.min(policy.leadSeconds * 1000, Math.max(0, ttl - interval))
  return Math.max(now, evidence.lastCacheEvidenceAt + ttl - lead, (lastAttempt ?? evidence.lastCacheEvidenceAt) + interval)
}
