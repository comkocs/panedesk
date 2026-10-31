/** Admission configuration refusals contain no source text, paths or nested exception detail. */
import type { SeatName, SeatRejected } from '@panedesk/dsh-seat'

/** Build the bilingual refusal before a Session or source intent is admitted.
 * @param seat - Affected catalog seat.
 * @returns Nonretryable definition refusal with no Session effects.
 */
export function definitionRefusal(seat: SeatName): SeatRejected {
  return { status: 'rejected', error: { code: 'invalid-definition',
    message: `Seat "${seat}" has an invalid definition; admission was refused. 工位“${seat}”定义无效，准入已拒绝。`,
    alternative: 'Repair the seat opening template or configuration and submit again. 请修好该工位开场模板或配置后重新提交。',
    retryable: false, effectState: 'none' } }
}

/** Recognize only an explicit definition refusal at a configuration-owned call site.
 * @param error - Direct configuration exception, never a persistence or authorization wrapper.
 * @returns Whether the direct exception or its structured local failure names invalid-definition.
 */
export function isDefinitionException(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  if ('code' in error) return error.code === 'invalid-definition'
  const failure = 'failure' in error ? error.failure : undefined
  return failure !== null && typeof failure === 'object' && 'code' in failure && failure.code === 'invalid-definition'
}
