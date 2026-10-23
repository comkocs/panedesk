/** Continuation admission uses child-owned cache and current-context evidence. */
import type { SeatCacheEvidence, SeatContextUsage, SeatFailure } from '@panedesk/dsh-seat'

/** Reject expired or unmeasurable continuation before the executor sends input.
 * @param cache - child cache lifetime and last activity.
 * @param context - most recent child context estimate.
 * @param thresholdTokens - resolved child context limit.
 * @param now - trusted wall clock in milliseconds.
 * @returns actionable refusal, or null when both evidence checks pass.
 */
export function checkContinuation(
  cache: SeatCacheEvidence, context: SeatContextUsage, thresholdTokens: number, now: number,
): SeatFailure | null {
  const alternative = 'Start a new subagent with the handoff summary.'
  if (context.status === 'known' && context.tokens >= thresholdTokens) {
    return { code: 'subagent-context-limit', message: 'The child context reached its limit.', alternative, retryable: false, effectState: 'none' }
  }
  const last = cache.lastActivityAt === null ? NaN : Date.parse(cache.lastActivityAt)
  if (!Number.isFinite(last) || last > now || cache.cacheTtlMs === null || context.status === 'unknown') {
    return { code: 'evidence-unavailable', message: 'Child cache or context evidence is unavailable.', alternative, retryable: false, effectState: 'none' }
  }
  if (now - last > cache.cacheTtlMs) {
    return { code: 'subagent-renewal-expired', message: 'The child cache lifetime has elapsed.', alternative, retryable: false, effectState: 'none' }
  }
  return null
}

/** Emit a steer reminder through an idempotent durable message owner.
 * @param host - optional delivery adapter; missing delivery is never reported as sent.
 * @param request - trusted child measurement and handoff data.
 * @returns delivery status without cancelling or replacing the current step.
 */
export async function remindChild(
  host: import('@panedesk/dsh-seat').SeatReminderHost | undefined,
  request: import('@panedesk/dsh-seat').SeatChildThresholdRequest,
): Promise<'sent' | 'below' | 'unknown' | 'unavailable'> {
  if (request.context.status === 'unknown') return 'unknown'
  if (request.context.tokens < request.thresholdTokens) return 'below'
  if (!host) return 'unavailable'
  const id = `seat-child:${request.sessionId}:${request.thresholdRevision}:${request.context.contextEpoch}`
  const accepted = await host.send({ sessionId: request.sessionId, id, kind: 'steer',
    content: `The child context reached its limit. Prepare a handoff summary for a new subagent.\n${request.handoff}` })
  return accepted === 'accepted' ? 'sent' : 'unavailable'
}
