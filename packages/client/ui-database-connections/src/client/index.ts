/** Database settings registration and generated Remote adapter. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-api-remotes/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import contribution from '@panedesk/dsh-db-connections/remote'
import { createSnapshotStore } from '@panedesk/dsh-client-store'
import { DatabaseSettings } from './DatabaseSettings.tsx'
import { en, zh } from './locales.ts'
import type { Injected, Inspection } from './props.ts'

export const inject = ['slots', 'locale', 'remote']

/** Mount only the settings methods; database clients and secrets stay on the Host. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.databaseConnections'], ctx => {
    ctx.effect(() => ctx.locale.register('databaseConnections', { en, zh }))
    const state = createSnapshotStore<Inspection>({ loading: true, filename: '', connections: [], error: '' })
    let closed = false, generation = 0
    ctx.effect(() => () => { closed = true; ++generation })
    const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    const refresh = async () => {
      const current = ++generation
      state.set({ ...state.getSnapshot(), loading: true, error: '' })
      try {
        const value = unwrap(await ctx.remote.databaseConnections.inspect())
        if (!closed && current === generation) state.set({ ...value, loading: false, error: '' })
      } catch (error) {
        if (!closed && current === generation) state.set({ ...state.getSnapshot(), loading: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const inject = (): Injected => ({
      hooks: { inspection: state }, refresh,
      async save(input) { unwrap(await ctx.remote.databaseConnections.save(input)); await refresh() },
      async remove(id) { unwrap(await ctx.remote.databaseConnections.remove(id)); await refresh() },
      async test(input) { return unwrap(await ctx.remote.databaseConnections.test(input)) },
      async browse(path) { return unwrap(await ctx.remote.databaseConnections.browseKeys(path)) },
      async open(path) { unwrap(await ctx.remote.session.openWorkspacePath({ path })) },
    })
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'database-connections', group: 'panedesk', order: 30,
      label: () => ctx.locale.bind('databaseConnections')('title'), locale: 'databaseConnections', inject,
    }, DatabaseSettings))
    void refresh()
  })
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}
