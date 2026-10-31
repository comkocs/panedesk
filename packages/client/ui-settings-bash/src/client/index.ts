/**
 * Windows Git Bash setup row, browser half: a General Settings row that
 * reports the Host's first-run probe, offers the one-click commit of the
 * confirmed selection, and carries the install instructions when nothing
 * is installed. Off Windows the row renders nothing.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@panedesk/cordis'
// Type-only: pulls the ctx.remote merge and the generated bashSetup face.
import type {} from '@panedesk/dsh-api-remotes/client'
// Type-only: pulls the ctx.locale merge.
import type {} from '@panedesk/dsh-client-locale/client'
// Type-only: the settings slot declarations. Cross-plugin collaboration goes
// through the slot, never a value import (client bundle purity gate).
import type {} from '@panedesk/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.slots merge the registration below reads.
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import { BashSetupRow, type BashSetupRowInjected } from './BashSetupRow.tsx'
import { en, zh, type BashSetupLocaleKey } from './locales.ts'

export type { BashSetupView } from './BashSetupRow.tsx'
export type { BashSetupRowInjected } from './BashSetupRow.tsx'
export type { BashSetupLocaleKey } from './locales.ts'

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Windows Git Bash setup row copy. */
    'settings.bashSetup': BashSetupLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.bashSetup'

/**
 * Required services (cordis fiber inject): slots and locale for the Settings
 * row, the generated `bashSetup` Remote face for every fact and write.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.bashSetup']

/** Unwrap a RemoteResult or throw, so the row treats a failed call as its error view. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('bash setup: remote call failed')
  return result.value
}

/**
 * Register the `settings.bashSetup` dictionaries and the General row once the
 * `settings.general.item` slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'bash-setup', order: 55, locale: NS,
    inject: (): BashSetupRowInjected => ({
      read: async () => unwrap(await ctx.remote.bashSetup.status()),
      enable: async bashPath => unwrap(await ctx.remote.bashSetup.enable({ bashPath })),
      disable: async () => unwrap(await ctx.remote.bashSetup.disable()),
    }),
  }, BashSetupRow))
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-bash: dictionaries')
}
