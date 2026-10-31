/** Statistics resources and additive settings, main-area and session-tool contributions. */
import type { Context } from '@panedesk/cordis'
import type {} from '../types.ts'
import contribution from '@panedesk/dsh-client-ui-stats/remote'
import type {} from '@panedesk/dsh-api-gateway/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import { waitForPoll } from '@panedesk/dsh-client-resources/polling'
import type {} from '@panedesk/dsh-client-ui-layout/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type { MainPanelId } from '@panedesk/dsh-client-ui-layout/client'
import { RemoteError, remoteErrorOf, type RemoteResult, type TypertClientRemote } from '@panedesk/dsh-typert-protocol'
import { StatsPanel, StatsSettings, StatsTools } from './panel.tsx'
import { en, zh, type StatsKey } from './locales.ts'
import { selection } from './selection.ts'

/** Generated read result; no second handwritten wire data model. */
export type StatsData = Awaited<ReturnType<TypertClientRemote['stats']['read']>> extends RemoteResult<infer V> ? V : never
/** Navigation callback injected without exposing layout or transport objects. */
export interface StatsActions { open(this: void): void }

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { stats: StatsKey }
  interface ResourceProtocolMap { stats: StatsData }
}

/** Required registries and generated transport mount. */
export const inject = ['remote', 'slots', 'locale', 'resources', 'layout']

/** Mount the smallest read-only namespace and release every contribution with this plugin.
 * @param ctx - Client plugin lifetime and registries.
 * @returns Disposal of resources, slots, locale and generated Remote methods.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.stats'], (scope) => {
    const panel = '@panedesk/dsh-client-ui-stats' as MainPanelId
    const actions: StatsActions = { open: () => { scope.layout.selectPanel(panel) } }
    scope.effect(() => scope.locale.register('stats', { en, zh }), 'stats: locale')
    const t = scope.locale.bind('stats')
    scope.effect(() => scope.resources.register<'stats'>({
      protocol: 'stats',
      async *open(address, { signal }): AsyncIterable<RemoteResult<StatsData>> {
        const url = new URL(address)
        const request = selection(url.searchParams)
        const cancelled = () => signal.aborted
        while (!cancelled()) {
          let interval: number
          try {
            const result = await scope.remote.stats.read(request)
            if (cancelled()) return
            yield result
            if (!result.ok) return
            interval = result.value.refreshIntervalMs
          } catch (error) {
            if (!cancelled()) yield { ok: false, error: remoteErrorOf(error)
              ?? new RemoteError('stats/unavailable', 'Statistics are unavailable', {}) }
            return
          }
          if (url.searchParams.get('paused') === 'true') return
          await waitForPoll(signal, interval)
        }
      },
    }), 'stats: resources')
    scope.slots.inject('main', () => scope.slots.register({
      name: 'main', key: panel, locale: 'stats',
    }, StatsPanel))
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'stats', order: 70, label: () => t('title'), locale: 'stats', inject: () => actions,
    }, StatsSettings))
    scope.slots.inject('conversation.session.header.utilities', () => scope.slots.register({
      name: 'conversation.session.header.utilities', id: 'stats-tools', order: 70, locale: 'stats', inject: () => actions,
    }, StatsTools))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
