/** Administration reads redacted business effects from the running engine. */
import type * as Seat from '@panedesk/dsh-seat'
import { redact } from '@panedesk/dsh-seat-engine'
import type { HostAdminQueryRequest, HostAdminQueryResult } from './index.ts'

/** Read bounded business pages without issuing or querying authorization.
 * @param tasks - Running engine task projection.
 * @param request - Business filters and exclusive cursor.
 * @returns Redacted effects or a provider refusal.
 */
export async function queryAdmin(tasks: (request: HostAdminQueryRequest) => Promise<HostAdminQueryResult | Seat.SeatRejected>,
  request: HostAdminQueryRequest): Promise<HostAdminQueryResult | Seat.SeatRejected> {
  const effects = await tasks(request)
  if ('status' in effects) return effects
  return { ...effects, effects: effects.effects.map(redact) }
}
