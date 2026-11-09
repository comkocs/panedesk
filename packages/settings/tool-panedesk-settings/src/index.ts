/** Model-facing Panedesk preferences using the same writers as the settings pages. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-settings'
import type {} from '@panedesk/dsh-config-editor'
import { defineTool } from '@panedesk/dsh-tools'
import type {} from '@panedesk/dsh-storage-postgres'
import type { StorageSettings } from '@panedesk/dsh-storage-postgres/types'

/** Loader identity. */
export const name = 'tool-panedesk-settings'
/** Shared form reader and writer used by the settings pages. */
export const inject = ['tools', 'settings', 'configEditor']

const fields: Record<string, readonly string[]> = {
  '@panedesk/dsh-client-ui-settings-general': ['openingNameEnabled', 'openingName'],
  '@panedesk/dsh-client-ui-stats': ['enabled', 'refreshIntervalMs'],
  '@panedesk/dsh-client-ui-subagent-tree': ['externalRegistryFile', 'externalRegistryEnabled'],
  '@panedesk/dsh-client-ui-nodes': ['refreshIntervalMs'],
}
const skillFields = ['enabled', 'includeDefaultRoots', 'customSkillDirs', 'watch', 'watchPollIntervalMs']
const options: Record<string, object> = {
  enabled: [false, true], openingNameEnabled: [false, true], externalRegistryEnabled: [false, true],
  openingName: { sample: 'string', selected: 'nonempty string; trim outer whitespace only', left: 'string', right: 'string' },
  refreshIntervalMs: { type: 'integer', min: 1000, max: 2147483647 },
  externalRegistryFile: { type: 'string', description: 'Host-readable registry file path; empty disables the path' },
  includeDefaultRoots: [false, true], customSkillDirs: { type: 'array', items: 'string directory path' },
  watch: [false, true], watchPollIntervalMs: { type: 'integer', min: 1 },
}

/**
 * Register one reversible read/write tool with canonical before/after results.
 * @param ctx - Tool registry and the running profile's settings editor.
 */
export function apply(ctx: Context): void {
  const items = () => {
    const entries = ctx.configEditor.entries()
    return ctx.settings.describe({ redactSecrets: true }).flatMap(section => {
      const plugin = entries.find(entry => entry.options.id === section.ns)?.options.name ?? ''
      return (fields[plugin] ?? []).map(field => ({
        name: `${section.ns}.${field}`, section, field,
        current: (section.value as Record<string, unknown>)[field],
      }))
    })
  }
  const profileItems = () => {
    const entries = ctx.configEditor.entries()
    const links = entries.filter(entry => entry.options.name === '@panedesk/dsh-node-link')
    return entries.flatMap(entry => {
      const value = entry.fiber?.config as Record<string, unknown> | undefined
      const editable = value === undefined ? [] : entry.options.name === '@panedesk/dsh-skill-filesystem' ? skillFields
        : entry === links[0] && links.length === 1 && value.runtime !== undefined ? ['enabled'] : []
      return editable.map(field => ({ name: `${entry.options.id}.${field}`, entry, field, current: value![field] }))
    })
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'panedesk_settings',
    description: 'Read editable Panedesk settings and allowed values, or write one exact item name returned by read. Writes use the settings-page writer and return before and after. Items not listed are manual-only. Opening-name rules have sample, selected, left and right string fields. Read before writing; use the returned exact name, not a guessed namespace.',
    parameters: {
      action: { type: 'string', enum: ['read', 'write'], required: true },
      name: { type: 'string', description: 'Exact item name returned by read; required for write.' },
      value: { type: 'json', description: 'Replacement value; required for write.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: args => args.action === 'read',
    async execute(args) {
      const available = items()
      const profile = profileItems()
      const storage = ctx.get('postgresStorage')
      if (args.action === 'read') {
        const storageValue = await storage?.status()
        return JSON.stringify({ path: ctx.settings.documentPath, items: [
          ...available.map(({ name, current, section, field }) => ({ name, current: current ?? null, options: options[field], schema: section.schema })),
          ...profile.map(({ name, current, field }) => ({ name, current, options: options[field] })),
          ...storageValue ? [{ name: 'data-storage.settings', current: storageValue.settings,
            options: { backend: ['local', 'postgres'], connectionId: storageValue.connections }, path: storageValue.configPath }] : [],
        ] })
      }
      if (args.name === 'data-storage.settings' && storage) {
        const before = (await storage.status()).settings
        const value: unknown = args.value
        const after = await storage.save({ settings: value as StorageSettings })
        return JSON.stringify({ name: args.name, before, after: after.settings, restartRequired: after.restartRequired })
      }
      const profileItem = profile.find(item => item.name === args.name)
      if (profileItem && args.value !== undefined) {
        await ctx.configEditor.edit(profileItem.entry, current => ({ ...current, [profileItem.field]: args.value }))
        return JSON.stringify({ name: args.name, before: profileItem.current, after: profileItems().find(item => item.name === args.name)?.current })
      }
      const item = available.find(item => item.name === args.name)
      if (!item || args.value === undefined) throw new Error('Read settings first and supply an editable item name and value')
      await ctx.settings.mutate(item.section.ns, [{ op: 'set', path: [item.field], value: args.value }], item.section.revision)
      return JSON.stringify({ name: item.name, before: item.current ?? null, after: items().find(row => row.name === item.name)?.current ?? null })
    },
    presentCall: args => ({ card: 'generic', title: 'Panedesk settings', kind: args.action === 'read' ? 'read' : 'other', rawInput: args }),
  })))
}
