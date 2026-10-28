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
  const ledger = ctx.get('kernelStatus')?.snapshot().services.sessionLedger
  if (ledger === undefined) return values
  return { ...values, accountingStatus: { ledger: ledger.status, cause: ledger.cause } }
}
