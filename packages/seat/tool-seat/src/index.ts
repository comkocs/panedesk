/** Optional model consumers for node-local seats and registered directory roots. */
import type { Context } from '@panedesk/cordis'
import { registerDirectoryTools } from './directories.ts'
import { registerReportTools } from './report.ts'
import { registerWaitTools } from './wait.ts'
import { registerWindowTools } from './windows.ts'

/** Loader plugin identity. */
export const name = 'tool-seat'
/** Services are optional; absent providers contribute no tools. */
export const inject: string[] = []

/** Install contributions only while their providers exist.
 * @param ctx - reversible plugin owner.
 */
export function apply(ctx: Context): void {
  ctx.inject(['tools', 'seats'], (scope) => {
    registerWaitTools(scope)
    registerReportTools(scope)
    registerWindowTools(scope)
  })
  ctx.inject(['tools', 'seatDirectories'], registerDirectoryTools)
}
