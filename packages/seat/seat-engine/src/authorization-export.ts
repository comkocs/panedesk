/** Issued attribution exports remain separate from legacy engine effect documents. */
import type * as T from '@panedesk/dsh-seat'
import { canonical } from './journal.ts'

/** Serialize the entire bounded query page, including its next cursor and unknown attribution marker.
 * @param page - Verified projection result, or its structured query refusal.
 * @returns Independent versioned JSON without process-local authorization grants.
 */
export function exportAuthorizations(page: T.SeatIssuedAuthorizationQueryResult | T.SeatRejected):
Awaited<ReturnType<T.SeatAuthorizationExports['export']>> {
  if ('status' in page) return page
  return { format: 'seat-authorization/v1', content: canonical({ format: 'seat-authorization/v1', ...page }),
    complete: page.complete, watermark: page.watermark }
}
