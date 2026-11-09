/**
 * Cache pill plugin, node half. Serves the volatile visibility preference
 * through the settings forms; the browser half ships through exports["./client"].
 */

import type { Context, Volatile } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-settings'
import z from '@panedesk/schemastery'

/** Composer dock visibility of the cache pill. */
export interface Config {
  /** Show the cache pill in the composer dock. */
  visible: Volatile<boolean>
}

/** Live cache pill visibility, written from the Panedesk feature settings. */
export const Config = z.object({
  visible: z.boolean().default(false).volatile(),
})

/** Settings service that serves the visibility preference. */
export const inject = ['settings']

/**
 * Host plugin body: keep the automatic schema form off; the Panedesk feature
 * settings page owns this preference's row.
 * @param ctx - Host context carrying the settings service.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
}
