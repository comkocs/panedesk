/** Node resources and a secondary settings contribution; no initial-screen entry is registered. */
import type { Context } from '@panedesk/cordis'
import contribution from '@panedesk/dsh-client-ui-nodes/remote'
import type {} from '../types.ts'
import type {} from '@panedesk/dsh-api-gateway/client'
import type {} from '@panedesk/dsh-api-session-controller/remote'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import { waitForPoll } from '@panedesk/dsh-client-resources/polling'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import { RemoteError, remoteErrorOf, type RemoteResult, type TypertClientRemote } from '@panedesk/dsh-typert-protocol'
import type { NodeAction, NodeActionResult } from '../types.ts'
import { NodesSection } from './section.tsx'
import { en, zh, type NodesKey } from './locales.ts'

/** The generated read method owns the browser's data type. */
export type NodesData = Awaited<ReturnType<TypertClientRemote['nodes']['read']>> extends RemoteResult<infer V> ? V : never
/** Components receive fixed actions rather than a transport or context. */
export interface NodesActions {
  act(this: void, action: NodeAction): Promise<NodeActionResult>
  configure(this: void, change: Parameters<TypertClientRemote['nodes']['configure']>[0]): Promise<void>
  openPath(this: void, path: string, action: 'open' | 'reveal'): Promise<void>
}

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { nodes: NodesKey }
  interface ResourceProtocolMap { nodes: NodesData }
}

/** Registries used by the node settings contribution. */
export const inject = ['remote', 'slots', 'locale', 'resources']

/** Mount the generated namespace and dispose polling, settings and locale contributions together.
 * @param ctx - Client registry and plugin lifetime.
 * @returns Complete asynchronous disposal, including the generated Remote mount.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.nodes', 'remote.session'], (scope) => {
    scope.effect(() => scope.locale.register('nodes', { en, zh }), 'nodes: locale')
    const t = scope.locale.bind('nodes')
    const actions: NodesActions = { act: async (action) => {
      try {
        const result = await scope.remote.nodes.act(action)
        return result.ok ? result.value : { status: 'rejected', code: result.error.code }
      } catch (error) {
        return { status: 'uncertain', code: remoteErrorOf(error)?.code ?? 'nodes/unavailable' }
      }
    }, configure: async (change) => {
      const result = await scope.remote.nodes.configure(change)
      if (!result.ok) throw result.error
    }, openPath: async (path, action) => {
      const result = await scope.remote.session.openWorkspacePath({ path, action })
      if (!result.ok) throw result.error
    } }
    scope.effect(() => scope.resources.register<'nodes'>({
      protocol: 'nodes',
      async *open(_address, { signal }): AsyncIterable<RemoteResult<NodesData>> {
        const aborted = () => signal.aborted
        while (!aborted()) {
          let interval: number
          try {
            const result = await scope.remote.nodes.read()
            if (aborted()) return
            yield result
            if (!result.ok || !result.value.enabled) return
            interval = result.value.refreshIntervalMs
          } catch (error) {
            if (!aborted()) yield { ok: false, error: remoteErrorOf(error)
              ?? new RemoteError('nodes/unavailable', 'Node settings are unavailable', {}) }
            return
          }
          await waitForPoll(signal, interval)
        }
      },
    }), 'nodes: resources')
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'nodes', group: 'panedesk', order: 75, label: () => t('title'), locale: 'nodes', inject: () => actions,
    }, NodesSection))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
