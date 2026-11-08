/** Subagent delegation-limit settings in the Plugins page. */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@panedesk/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@panedesk/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@panedesk/dsh-client-ui-plugin-manager/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@panedesk/cordis'
import { SubagentCard } from './SubagentCard.tsx'
import { SubagentLimitsCardController } from './subagent-limits-card-controller.ts'
import { en, zh, type SubagentSettingsLocaleKey } from './locales.ts'

export type { SubagentCardProps } from './SubagentCard.tsx'
export type { SubagentLimitsCardFace, SubagentLimitsCardState, SubagentLimitsSettings } from './subagent-limits-card-controller.ts'
export type { SubagentSettingsLocaleKey } from './locales.ts'

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subagent settings page copy. */
    'settings.subagent': SubagentSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.subagent'

/**
 * Namespace of the delegation limits. Spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const SUBAGENT_NS = 'subagent'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the Subagent settings page while the Host serves its limits namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-subagent: dictionaries')
  const limits = new SubagentLimitsCardController(ctx.configForms.get(SUBAGENT_NS))
  ctx.effect(() => () => { limits.dispose() }, 'ui-settings-subagent: limits form subscription')
  const limitsFace = limits.inject()
  ctx.effect(() => ctx.configForms.whileServed([SUBAGENT_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'subagent',
    order: 10,
    label: () => t('subagentTitle'),
    locale: NS,
    inject: () => limitsFace,
  }, SubagentCard))), 'ui-settings-subagent: page')
}
