/** Welcome acknowledgement stored in the plugin configuration. */
import type {} from '@panedesk/dsh-settings'
import type {} from '@panedesk/dsh-session-title'
import type { OpeningNamePattern } from '@panedesk/dsh-session-title/types'

import type { Volatile, Context } from '@panedesk/cordis'

import z from '@panedesk/schemastery'
import ProductFeatures from './product-features.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Last acknowledged welcome notice version. */
  welcomeNoticeVersion: Volatile<string | undefined>
  /** Enable opening-message names and creation dates globally. */
  openingNameEnabled: Volatile<boolean>
  /** Sample and anchors used for new session names. */
  openingName: Volatile<OpeningNamePattern | undefined>
}

/** Live welcome preference. */
export const Config = z.object({
  welcomeNoticeVersion: z.string().volatile(),
  openingNameEnabled: z.boolean().default(true).volatile(),
  openingName: z.object({
    sample: z.string().default(''), selected: z.string().default(''),
    left: z.string().default(''), right: z.string().default(''),
  }).volatile(),
})

/** The browser consumes the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 * @param config Live global opening-name and welcome preferences.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], child => { child.plugin(ProductFeatures) })
  ctx.inject(['sessionTitle'], child => {
    child.effect(() => child.sessionTitle.configureOpeningName({
      enabled: () => config.openingNameEnabled.get(),
      pattern: () => {
        const pattern = config.openingName.get()
        return pattern?.sample && pattern.selected ? pattern : undefined
      },
    }))
  })
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
