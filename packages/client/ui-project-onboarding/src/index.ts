/** Product-owned, path-keyed project opening preferences. */
import type { Context, Volatile } from '@panedesk/cordis'
import ProjectOpening from './opening.ts'
import type {} from '@panedesk/dsh-settings'
import z from '@panedesk/schemastery'

import type { ProjectSelection } from './types.ts'

/** Product preferences, never stored inside the user's project. */
export interface Config {
  projects: Volatile<Record<string, ProjectSelection>>
}

/** Validate persisted per-workspace preferences. */
export const Config = z.object({
  projects: z.dict(z.object({
    mode: z.union(['off', 'remind', 'auto']).default('remind'),
    chosen: z.boolean().default(false),
  })).default({}).volatile(),
})

/** Loader and settings namespace identity. */
export const name = 'ui-project-onboarding'
/** Configuration service owning product persistence and authorization. */
export const inject = ['settings']

/** Hide automatic schema forms in favor of the project-specific page.
 * @param ctx Host context carrying the product settings service.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
  ctx.plugin(ProjectOpening)
}
