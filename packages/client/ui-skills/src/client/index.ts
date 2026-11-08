/**
 * Skills settings section, browser half. It registers one Settings navigation
 * entry for effective skills, scan directories, and global provider controls.
 */
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-api-remotes/client'
import type {} from '@panedesk/dsh-api-remote-access/types'
import type {} from '@panedesk/dsh-api-workspace-controller/client'
import type { Context as ClientContext } from '@panedesk/cordis'
import { SkillsSection } from './SkillsSection.tsx'
import type { SkillPageOperations } from './catalog.ts'
import { en, zh } from './locales.ts'
import type { SkillsKey } from './locales.ts'

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only skill catalog copy. */
    'settings.skills': SkillsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.skills'

/** Required services. */
export const inject = ['slots', 'locale', 'remote', 'remote.skills', 'remote.session', 'workspaces']

/**
 * Mount the Skills section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skills: section dictionaries')
  const operations = createSkillPageOperations(ctx)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skills',
    group: 'panedesk',
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ operations, t, hooks: { directories: ctx.workspaces.list } }),
  }, SkillsSection))
}

/**
 * Bind the page's reads to the host namespaces this plugin injects.
 * @param ctx - the plugin context.
 * @returns the callbacks the section renders from.
 */
function createSkillPageOperations(ctx: ClientContext): SkillPageOperations {
  return {
    list: async (workspaceId) => {
      const response = await ctx.remote.skills.catalog(workspaceId)
      if (!response.ok) {
        if (response.error.code === 'skills/unavailable') return { kind: 'refused', reason: 'unavailable' }
        if (response.error.code === 'skills/disabled') return { kind: 'refused', reason: 'disabled' }
        if (response.error.code === 'remote-access/denied') return { kind: 'refused', reason: 'denied' }
        return { kind: 'refused', reason: 'failed', message: response.error.message }
      }
      return { kind: 'listed', ...response.value, workspace: workspaceId !== undefined }
    },
    configure: async (ns, patch) => {
      const response = await ctx.remote.skills.configure(ns, patch)
      return response.ok ? undefined : response.error.message
    },
    open: async (path, action) => {
      const response = await ctx.remote.session.openWorkspacePath({ path, ...(action === 'reveal' ? { action } : {}) })
      return response.ok ? undefined : response.error.message
    },
  }
}
