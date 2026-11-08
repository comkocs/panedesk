/** Settings contribution using generated owner-authenticated Remote methods. */
import type { Context } from '@panedesk/cordis'
import contribution from '@panedesk/dsh-client-ui-storage/remote'
import type {} from '@panedesk/dsh-api-gateway/client'
import type {} from '@panedesk/dsh-api-session-controller/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type { RemoteResult } from '@panedesk/dsh-typert-protocol'
import type { ConnectionResult, StorageSettingsInput, StorageStatus } from '@panedesk/dsh-storage-postgres/types'
import { StorageSettingsPage } from './page.tsx'
import { en, zh, type StorageKey } from './locales.ts'

export interface StorageActions {
  save(this: void, input: StorageSettingsInput): Promise<RemoteResult<StorageStatus>>
  test(this: void, input: StorageSettingsInput): Promise<RemoteResult<ConnectionResult>>
  migrate(this: void): Promise<RemoteResult<number>>
  open(this: void, path: string, reveal: boolean): Promise<boolean>
}

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { dataStorage: StorageKey }
  interface ResourceProtocolMap { 'data-storage': StorageStatus }
}

export const inject = ['remote', 'remote.session', 'slots', 'locale', 'resources']

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.dataStorage'], scope => {
    scope.effect(() => scope.locale.register('dataStorage', { en, zh }))
    scope.effect(() => scope.resources.register<'data-storage'>({
      protocol: 'data-storage', async *open() { yield await scope.remote.dataStorage.read() },
    }))
    const actions: StorageActions = {
      save: input => scope.remote.dataStorage.save(input),
      test: input => scope.remote.dataStorage.test(input),
      migrate: () => scope.remote.dataStorage.migrate(),
      open: async (path, reveal) => (await scope.remote.session.openWorkspacePath(reveal ? { path, action: 'reveal' } : { path })).ok,
    }
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'data-storage', group: 'panedesk', order: 72,
      label: () => scope.locale.bind('dataStorage')('title'), locale: 'dataStorage', inject: () => actions,
    }, StorageSettingsPage))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
