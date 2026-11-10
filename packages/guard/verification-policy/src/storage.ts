/** The sole persistence adapter: one versioned verification record per workspace. */
import type { Context } from '@panedesk/cordis'
import { z } from 'zod'
import { defineDomain, domainTable } from '@panedesk/dsh-storage-domain'
import type { WorkspaceId } from '@panedesk/dsh-workspace/types'
import type { VerificationSettings, VerificationPreset } from './types.ts'
import type {} from '@panedesk/dsh-trace-store'

const settingsSchema = z.object({
  version: z.literal(1).default(1), enabled: z.boolean().default(true),
  fullTests: z.enum(['allow', 'once', 'deny']).default('once'),
  mutation: z.boolean().default(false), scripts: z.boolean().default(true),
  ci: z.boolean().default(true), focusedTests: z.boolean().default(true),
  clientMinutes: z.number().positive().nullable().default(null),
  budget: z.object({ minutes: z.number().positive().nullable().default(null),
    percent: z.number().min(0).max(100).nullable().default(null),
    action: z.enum(['ask', 'deny']).default('ask') }).default({ minutes: null, percent: null, action: 'ask' }),
})

/** Product presets share the same versioned representation as saved settings. */
export const presets: Record<VerificationPreset, VerificationSettings> = {
  default: settingsSchema.parse({}),
  unlimited: settingsSchema.parse({ fullTests: 'allow', mutation: true }),
  'build-only': settingsSchema.parse({ fullTests: 'deny', mutation: false, scripts: false, ci: false, focusedTests: false, clientMinutes: 5 }),
}

const spec = defineDomain({ name: 'workspace-verification', version: 1,
  tables: { settings: domainTable<WorkspaceId, VerificationSettings>(settingsSchema) } })

/** Open workspace storage independently of project files and model-editable settings.
 * @param ctx Host storage-domain owner.
 * @returns Read/write adapter whose lifetime follows the plugin.
 */
export async function openVerificationStorage(ctx: Context) {
  const domain = await ctx.storageDomain.open(spec)
  ctx.effect(() => () => domain.close())
  const table = domain.table('settings')
  const key = 'verification-policy'
  ctx.inject(['traceStore'], traceCtx => {
    traceCtx.effect(() => traceCtx.traceStore.registerSettingSource(key,
      workspaceId => JSON.stringify(table.get(workspaceId) ?? presets.default)))
  })
  return {
    read: (workspaceId: WorkspaceId): VerificationSettings => {
      const saved = ctx.get('traceStore')?.readSetting(workspaceId, key)
      return saved === undefined ? table.get(workspaceId) ?? presets.default : settingsSchema.parse(JSON.parse(saved))
    },
    save: async (workspaceId: WorkspaceId, settings: VerificationSettings): Promise<void> => {
      const parsed = settingsSchema.parse(settings)
      if (await ctx.get('traceStore')?.saveSetting(workspaceId, key, JSON.stringify(parsed))) return
      await table.put(workspaceId, parsed)
    },
  }
}
