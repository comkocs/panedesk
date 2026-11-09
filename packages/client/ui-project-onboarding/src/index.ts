/** Product-owned, path-keyed project opening preferences. */
import { resolve } from 'node:path'
import type { Context, Volatile } from '@panedesk/cordis'
import ProjectOpening from './opening.ts'
import { presetName } from './preset-name.ts'
import { workflowDefaults, type WorkflowPrompts } from './workflow-defaults.ts'
import type {} from '@panedesk/dsh-settings'
import z from '@panedesk/schemastery'

import type { OpeningPreset, ProjectSelection } from './types.ts'

/** Product preferences, never stored inside the user's project. */
export interface Config {
  /** Localized requirements-review draft. */
  workflowRequirementsPrompt: Volatile<WorkflowPrompts['workflowRequirementsPrompt']>
  /** Localized workflow-setup draft. */
  workflowSetupPrompt: Volatile<WorkflowPrompts['workflowSetupPrompt']>
  /** Localized workflow-checkup draft. */
  workflowCheckupPrompt: Volatile<WorkflowPrompts['workflowCheckupPrompt']>
  /** Reusable opening drafts stored in the product profile. */
  openingPresets: Volatile<OpeningPreset[]>
  /** Show optional workflow starters above the composer on new sessions. */
  showWorkflowStarters: Volatile<boolean>
  /** Saved opening choices keyed by absolute workspace directory in product settings. */
  projects: Volatile<Record<string, ProjectSelection>>
}

/** Validate persisted per-workspace preferences. */
export const Config = z.object({
  openingPresets: z.array(z.object({
    name: z.transform(z.string().required(), presetName), prompt: z.string().required(),
    directories: z.array(z.string().required()).min(1).required(),
    model: z.string(), permission: z.string(),
  })).default([]).volatile(),
  showWorkflowStarters: z.boolean().default(true).volatile(),
  workflowRequirementsPrompt: z.object({ zh: z.string(), en: z.string() }).default(workflowDefaults.workflowRequirementsPrompt).volatile(),
  workflowSetupPrompt: z.object({ zh: z.string(), en: z.string() }).default(workflowDefaults.workflowSetupPrompt).volatile(),
  workflowCheckupPrompt: z.object({ zh: z.string(), en: z.string() }).default(workflowDefaults.workflowCheckupPrompt).volatile(),
  projects: z.dict(z.object({
    mode: z.union(['off', 'remind', 'auto']).default('auto'),
    chosen: z.boolean().default(false),
  })).default({}).volatile(),
})

/** Loader and settings namespace identity. */
export const name = 'ui-project-onboarding'
/** Configuration service owning product persistence and authorization. */
export const inject = ['settings']

/** Hide automatic schema forms in favor of the project-specific page.
 * @param ctx Host context carrying the product settings service.
 * @param config Live product-owned workspace selections.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
  ctx.inject(['seatEngine'], (ctx) => {
    ctx.effect(() => ctx.seatEngine.registerProjectPolicyResolver((definition) => {
      const projects = config.projects.get()
      const modes = new Set(definition.directories.flatMap((directory) => {
        const selection = projects[resolve(directory.path)]
        return selection?.chosen ? [selection.mode] : []
      }))
      if (modes.size > 1) throw new Error('Seat directories have conflicting saved project choices')
      return modes.values().next().value
    }))
  })
  ctx.plugin(ProjectOpening, config)
}
