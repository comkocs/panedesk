/** Current Host accounting availability added only to outgoing projection values. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-app-boot'
import type { SessionProjectionValues } from './types.ts'

/** Add the current startup audit without persisting it as Session-derived state.
 * @param ctx - Host context with an optional published kernel audit.
 * @param values - Existing validated projection values, left unchanged without an audit.
 * @returns outgoing values with ledger availability when the audit exists.
 */
export function withAccountingStatus(ctx: Context, values: SessionProjectionValues): SessionProjectionValues {
  const services = ctx.get('kernelStatus')?.snapshot().services
  if (services === undefined) return values
  return Object.assign({}, values, { accountingStatus: { ledger: services.sessionLedger.status, cause: services.sessionLedger.cause,
    cache: { status: services.llmCache.status, cause: services.llmCache.cause } } })
}
