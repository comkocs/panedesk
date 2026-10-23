/** Inert seat-local plugin entry; activation contributes no services or effects. */
import type { Context } from '@panedesk/cordis'

/** Stable plugin identity for explicit composition. */
export const name = 'seat-local'

/** No services are required by the inert entry. */
export const inject = []

/** Load without registering behavior.
 * @param _ctx - owning plugin context.
 */
export function apply(_ctx: Context): void {}
