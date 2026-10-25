/** Administration combines redacted effects with the independent issued-authorization projection. */
import type * as Seat from '@panedesk/dsh-seat'
import { redact } from '@panedesk/dsh-seat-engine'
import type { HostAdminQueryRequest, HostAdminQueryResult } from './index.ts'

/** Read bounded pages without treating legacy effects as complete authorization history.
 * @param queries - Running engine effect projection.
 * @param authorization - Capability-aware authorization owner.
 * @param request - Shared filters and independent exclusive cursors.
 * @returns Redacted effects plus a separately paginated authorization page, or refusal.
 */
export async function queryAdmin(queries: Seat.SeatAuthorizationQueries, authorization: Seat.SeatAuthorizationTransactions,
  request: HostAdminQueryRequest): Promise<HostAdminQueryResult | Seat.SeatRejected> {
  const { authorizationCursor, kind, ...effectsRequest } = request
  const effects = await queries.tasks(effectsRequest)
  if ('status' in effects) return effects
  const { cursor: _cursor, kinds: _kinds, ...filters } = effectsRequest
  const authorizations = await authorization.query({ ...filters, ...(kind ? { kind } : {}),
    ...(authorizationCursor ? { cursor: authorizationCursor } : {}) })
  if ('status' in authorizations) return authorizations
  return { ...effects, effects: effects.effects.map(redact), authorizations }
}
