/** Structured failures shared by local catalog and window operations. */
import type { SeatErrorCode, SeatFailure, SeatRejected } from '@panedesk/dsh-seat'

/** Expected refusal; callers retain the structured failure rather than parsing text. */
export class SeatLocalError extends Error {
  constructor(readonly failure: SeatFailure) { super(failure.message) }
}

/** Construct a refusal without claiming any side effect.
 * @param code - stable failure discriminator.
 * @param message - safe diagnostic.
 * @param alternative - actionable next operation.
 * @returns an explicit rejection.
 */
export function rejected(code: SeatErrorCode, message: string, alternative: string): SeatRejected {
  return { status: 'rejected', error: { code, message, alternative, retryable: false, effectState: 'none' } }
}

/** Stop dependent work with a typed refusal.
 * @param code - stable failure discriminator.
 * @param message - safe diagnostic.
 * @param alternative - safe next operation.
 * @returns never; throws a structured local failure.
 */
export function refuse(code: SeatErrorCode, message: string, alternative: string): never {
  throw new SeatLocalError(rejected(code, message, alternative).error)
}
