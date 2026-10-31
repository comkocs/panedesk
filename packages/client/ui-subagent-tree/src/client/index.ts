/**
 * Subagent tree plugin, browser half: contributes the session-header pill and
 * the right-sidebar tree tab over one owner-authorized read-only Remote. The
 * tree and monitoring views stay read-only; stopping a session keeps its
 * upstream session controls.
 */
import type { Context as ClientContext } from '@panedesk/cordis'
import type {} from '../types.ts'
import contribution from '@panedesk/dsh-client-ui-subagent-tree/remote'
import type {} from '@panedesk/dsh-api-session-controller/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type { SessionId } from '@panedesk/dsh-session/types'
import type {} from '@panedesk/dsh-client-ui-sidebar-right/client'
import { RemoteError, remoteErrorOf, type RemoteResult, type TypertClientRemote } from '@panedesk/dsh-typert-protocol'
import { SubagentTreeAction, SubagentTreeTab, type SubagentTreeActions, type SubagentTreeLabels } from './panel.tsx'
import { en, zh, type SubagentTreeKey } from './locales.ts'

/** Stable implementation identity for the tree tab body and pill registration. */
export const SUBAGENT_TREE_ID = '@panedesk/dsh-client-ui-subagent-tree'

/** Resource-address prefix for one session's subagent tree page. */
export const SUBAGENT_TREE_ADDRESS = 'dsh-resource://subagenttree/session/'

/** Generated read result; no second handwritten wire data model. */
export type SubagentTreeData = Awaited<ReturnType<TypertClientRemote['subagentTree']['read']>> extends RemoteResult<infer V> ? V : never

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subagent tree copy. */
    'subagentTree': SubagentTreeKey
  }

  interface ResourceProtocolMap {
    /** One session's read-only subagent tree view. */
    subagenttree: SubagentTreeData
  }
}

/**
 * Address one session's subagent tree page.
 * @param sessionId - the on-screen session whose tree the tab shows.
 * @returns canonical Sidebar resource address.
 */
export function subagentTreeAddress(sessionId: SessionId): string {
  return `${SUBAGENT_TREE_ADDRESS}${encodeURIComponent(sessionId)}`
}

/**
 * Parse one canonical subagent tree resource address.
 * @param value - possible tree resource address.
 * @returns the session id, or `undefined` for another or malformed resource.
 */
export function parseSubagentTreeAddress(value: string): SessionId | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch (_invalidUrl) {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'subagenttree') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  try {
    return decodeURIComponent(parts[1] as string) as SessionId
  } catch (_invalidEncoding) {
    return undefined
  }
}

/** Required registries and the generated transport mount. */
export const inject = ['remote', 'slots', 'locale', 'resources', 'sidebarRightTabs', 'sidebarRight', 'sessions']

/**
 * Mount the read-only namespace, the tree resource with its refresh loop, the
 * session-header pill, and the right-sidebar tab type and body.
 * @param ctx - Client plugin lifetime and registries.
 * @returns Disposal of the Remote mount and every registry contribution.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.subagentTree', 'sessions'], (scope) => {
    scope.effect(() => scope.locale.register('subagentTree', { en, zh }), 'subagentTree: locale')
    const t = scope.locale.bind('subagentTree')
    const labelOf = (sessionId: SessionId): string => {
      const entry = scope.sessions.list.getSnapshot().byId[sessionId]
      return entry?.projectionValues?.subagent?.label ?? entry?.displayTitle ?? sessionId
    }
    scope.effect(() => scope.resources.register<'subagenttree'>({
      protocol: 'subagenttree',
      async *open(resourceAddress, { signal }): AsyncIterable<RemoteResult<SubagentTreeData>> {
        const sessionId = parseSubagentTreeAddress(resourceAddress)
        if (sessionId === undefined) {
          yield { ok: false, error: new RemoteError('subagentTree/unavailable', 'Invalid subagent tree address', {}) }
          return
        }
        const cancelled = () => signal.aborted
        let interval = 5000
        while (!cancelled()) {
          try {
            const result = await scope.remote.subagentTree.read({ sessionId })
            if (cancelled()) return
            yield result
            if (!result.ok) return
            interval = result.value.refreshIntervalMs
          } catch (error) {
            if (!cancelled()) {
              yield { ok: false, error: remoteErrorOf(error)
                ?? new RemoteError('subagentTree/unavailable', 'The subagent tree is unavailable', {}) }
            }
            return
          }
          await new Promise<void>((resolve) => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
            const timer = setTimeout(finish, interval)
            signal.addEventListener('abort', finish, { once: true })
            if (signal.aborted) finish()
          })
        }
      },
    }), 'subagentTree: resources')
    scope.effect(() => scope.sidebarRightTabs.register({
      id: SUBAGENT_TREE_ID,
      kind: 'subagenttree',
      patterns: [`${SUBAGENT_TREE_ADDRESS}**`],
      priority: 'extension',
      canOpen: address => parseSubagentTreeAddress(address) !== undefined,
      title: () => t('title'),
    }), 'subagentTree: sidebar tab type')
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: SUBAGENT_TREE_ID,
      locale: 'subagentTree',
      inject: (): SubagentTreeLabels => ({ labelOf }),
    }, SubagentTreeTab))
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'subagent-tree',
      // After the subagent catalog pill (10) and the background-task roster (20).
      order: 15,
      locale: 'subagentTree',
      inject: (): SubagentTreeActions => ({
        open: (sessionId) => { scope.sidebarRight.openResourceIn(sessionId, subagentTreeAddress(sessionId), { kind: 'subagenttree' }) },
      }),
    }, SubagentTreeAction))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
