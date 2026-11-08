/** Resource-backed statistics and profile configuration contributions. */
import type { Context } from '@panedesk/cordis'
import type {} from '../types.ts'
import contribution from '@panedesk/dsh-client-ui-stats/remote'
import type {} from '@panedesk/dsh-api-gateway/client'
import type {} from '@panedesk/dsh-api-session-controller/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import { waitForPoll } from '@panedesk/dsh-client-resources/polling'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type { ConfigForm } from '@panedesk/dsh-client-ui-settings/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import { RemoteError, remoteErrorOf, type RemoteResult, type TypertClientRemote } from '@panedesk/dsh-typert-protocol'
import { StatsSettings, StatsTools } from './panel.tsx'
import { en, zh, type StatsKey } from './locales.ts'
import { selection } from './selection.ts'

/** Generated snapshot types remain owned by the Host service. */
export type StatsData = Awaited<ReturnType<TypertClientRemote['stats']['read']>> extends RemoteResult<infer V> ? V : never
/** Generated storage locations, available even when statistics are disabled. */
export type StatsLocations = Awaited<ReturnType<TypertClientRemote['stats']['locations']>> extends RemoteResult<infer V> ? V : never
/** Editable scalar values in the existing profile configuration. */
export interface StatsPreferences { enabled: boolean; refreshIntervalMs: number }
/** Narrow settings actions and the framework-bound configuration source. */
export interface StatsSettingsActions {
  hooks: { preferences: ConfigForm<StatsPreferences> }
  setPreference(this: void, field: keyof StatsPreferences, value: boolean | number): Promise<boolean>
  openPath(this: void, path: string, action: 'open' | 'reveal'): Promise<boolean>
}

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { stats: StatsKey }
  interface ResourceProtocolMap { stats: StatsData; 'stats-locations': StatsLocations }
}

/** Existing forms own persisted writes and conflict recovery. */
export const inject = ['remote', 'remote.session', 'slots', 'locale', 'resources', 'configForms']

/** Mount generated reads, profile forms and the Session-header entry.
 * @param ctx - Client plugin lifetime and registries.
 * @returns Disposal of all contributions and generated Remote methods.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.stats'], (scope) => {
    const preferences = scope.configForms.get<StatsPreferences>('ui-stats')
    const actions: StatsSettingsActions = {
      hooks: { preferences },
      setPreference: (field, value) => preferences.set(field, value),
      openPath: async (path, action) => (await scope.remote.session.openWorkspacePath(action === 'reveal' ? { path, action } : { path })).ok,
    }
    scope.effect(() => scope.locale.register('stats', { en, zh }), 'stats: locale')
    const t = scope.locale.bind('stats')
    scope.effect(() => scope.resources.register<'stats-locations'>({
      protocol: 'stats-locations',
      async *open() { yield await scope.remote.stats.locations() },
    }), 'stats: locations')
    scope.effect(() => scope.resources.register<'stats'>({
      protocol: 'stats',
      async *open(address, { signal }): AsyncIterable<RemoteResult<StatsData>> {
        const url = new URL(address)
        const request = selection(url.searchParams)
        while (!signal.aborted) {
          let interval: number
          try {
            const result = await scope.remote.stats.read(request)
            if (signal.aborted) return
            yield result
            if (!result.ok) return
            interval = result.value.refreshIntervalMs
          } catch (error) {
            if (!signal.aborted) yield { ok: false, error: remoteErrorOf(error)
              ?? new RemoteError('stats/unavailable', 'Statistics are unavailable', {}) }
            return
          }
          if (url.searchParams.get('paused') === 'true') return
          await waitForPoll(signal, interval)
        }
      },
    }), 'stats: resources')
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'stats', group: 'panedesk', order: 70, label: () => t('title'), locale: 'stats', inject: () => actions,
    }, StatsSettings))
    scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
      name: 'conversation.session.header.actions', id: 'stats-tools', order: 30, locale: 'stats',
    }, StatsTools))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
