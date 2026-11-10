/**
 * Subagent tree plugin, browser half: contributes the session-header pill and
 * the right-sidebar tree tab and shared map controls over existing session
 * interruption and the external registry Remote.
 */
import type { Context as ClientContext } from '@panedesk/cordis'
import type { SubagentTreeNode } from '../types.ts'
import { isActive, modelColor, type SubagentTreeUI } from './presentation.ts'
export type { SubagentTreeUI } from './presentation.ts'
export type { SubagentTreeNode } from '../types.ts'
import contribution from '@panedesk/dsh-client-ui-subagent-tree/remote'
import verificationContribution from '@panedesk/dsh-verification-policy/remote'
import type {} from '@panedesk/dsh-api-session-controller/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import { waitForPoll } from '@panedesk/dsh-client-resources/polling'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type { SessionId } from '@panedesk/dsh-session/types'
import type {} from '@panedesk/dsh-client-ui-sidebar-right/client'
import { RemoteError, remoteErrorOf, type RemoteResult, type TypertClientRemote } from '@panedesk/dsh-typert-protocol'
import { SubagentTreeAction, SubagentTreeTab, type SubagentTreeActions, type SubagentTreeLabels } from './panel.tsx'
import { en, zh, type SubagentTreeKey } from './locales.ts'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type {} from '@panedesk/dsh-tool-verification-checklist/client'
import { RegistrySettingsRow, type RegistrySettings, type RegistrySettingsFace } from './settings.tsx'
import { ParentActivity } from './activity.tsx'
import { ActivitySettingsRow, type ActivitySettings, type ActivitySettingsFace } from './activity-settings.tsx'

/** Stable implementation identity for the tree tab body and pill registration. */
export const SUBAGENT_TREE_ID = '@panedesk/dsh-client-ui-subagent-tree'

/** Resource-address prefix for one session's subagent tree page. */
export const SUBAGENT_TREE_ADDRESS = 'dsh-resource://subagenttree/session/'

/** Generated read result; no second handwritten wire data model. */
export type SubagentTreeData = Awaited<ReturnType<TypertClientRemote['subagentTree']['read']>> extends RemoteResult<infer V> ? V : never

declare module '@panedesk/dsh-client-ui-slots' {
  interface SlotMap {
    /** Native child preview and navigation contributed by the subagent UI. */
    'subagent.tree.details': {
      kind: 'single'
      scope: 'session'
      owner: { parentSessionId: SessionId; childSessionId: SessionId; label: string; close: () => void }
    }
  }

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
export const inject = ['remote', 'slots', 'locale', 'resources', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'settingsNavigation']

/**
 * Mount the read-only namespace, the tree resource with its refresh loop, the
 * session-header pill, and the right-sidebar tab type and body.
 * @param ctx - Client plugin lifetime and registries.
 * @returns Disposal of the Remote mount and every registry contribution.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const disposeVerification = await ctx.remote.$mount(verificationContribution)
  const ui = ctx.inject(['remote.subagentTree', 'remote.subagents', 'remote.session', 'remote.verificationPolicy', 'sessions'], (scope) => {
    const stop = async (node: SubagentTreeNode, selected = true): Promise<void> => {
      for (const child of node.children) await stop(child, false)
      if (!selected && !isActive(node.status)) return
      const result = node.external
        ? await scope.remote.subagentTree.stopExternal({ sessionId: node.sessionId })
        : node.parentSessionId === null
          ? await scope.remote.session.cancel({ sessionId: node.sessionId })
          : await scope.remote.subagents.interruptByParent(node.sessionId, node.parentSessionId, 'continuable')
      if (!result.ok) throw result.error
    }
    const presentation: SubagentTreeUI = { address: subagentTreeAddress, modelColor, isActive, stop }
    scope.effect(() => scope.reflect.provide('subagentTreeUI', presentation), 'subagentTree: shared controls')
    scope.effect(() => scope.locale.register('subagentTree', { en, zh }), 'subagentTree: locale')
    const t = scope.locale.bind('subagentTree')
    scope.inject(['configForms'], settings => {
      const activityForm = settings.configForms.get<ActivitySettings>('activity-category')
      settings.effect(() => settings.configForms.whileServed(['activity-category'], () => settings.slots.inject('settings.panedesk.item', () =>
        settings.slots.register({
          name: 'settings.panedesk.item', id: 'activity-category-rules', order: 21, locale: 'subagentTree',
          inject: (): ActivitySettingsFace => ({ hooks: { activityRules: activityForm },
            saveRules: (path, rows) => activityForm.mutate([{ op: 'set', path: ['projects', path], value: rows.map(row => ({ ...row })) }]),
          }),
        }, ActivitySettingsRow))))
      const namespace = 'ui-subagent-tree'
      const form = settings.configForms.get<RegistrySettings>(namespace)
      settings.effect(() => settings.configForms.whileServed([namespace], () => settings.slots.inject('settings.panedesk.item', () =>
        settings.slots.register({
          name: 'settings.panedesk.item', id: 'external-subagent-registry', order: 20, locale: 'subagentTree',
          inject: (): RegistrySettingsFace => {
            const picker = (globalThis as typeof globalThis & {
              __DSH_FILE_PICKER__?: { pick(): Promise<string | null> }
            }).__DSH_FILE_PICKER__
            return {
              hooks: { registry: form, document: settings.configForms.describe() },
              chooseFile: picker === undefined ? undefined : () => picker.pick(),
              setEnabled: enabled => form.set('externalRegistryEnabled', enabled),
              save: path => form.mutate([
                { op: 'set', path: ['externalRegistryFile'], value: path },
                { op: 'set', path: ['externalRegistryEnabled'], value: path !== '' },
              ]),
              openPath: async (path, action) => (await scope.remote.session.openWorkspacePath(action === 'reveal' ? { path, action } : { path })).ok,
            }
          },
        }, RegistrySettingsRow))))
    })
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
          await waitForPoll(signal, interval)
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
      children: { 'subagent.tree.details': { kind: 'single', scope: 'session' } },
      locale: 'subagentTree',
      inject: (): SubagentTreeLabels => ({ labelOf, stop,
        openVerification: () => { scope.settingsNavigation.openSection('verification') },
        setTestsStopped: async (node, prohibited) => {
          const result = await scope.remote.verificationPolicy.setTestsStopped({ sessionId: node.sessionId,
            taskId: node.verificationTaskId!, prohibited })
          if (!result.ok) throw result.error
        },
        prohibitChecklist: async (sessionId, taskId, category) => {
          const result = await scope.remote.verificationPolicy.prohibitTaskCategories({ sessionId, taskId, categories: [category] })
          if (!result.ok) throw result.error
        },
      }),
    }, SubagentTreeTab))
    scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
      name: 'conversation.composer.dock', id: 'activity-category-totals', order: 30, locale: 'subagentTree',
    }, ParentActivity))
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
  try { await ui } catch (error) { await ui.dispose(); await disposeVerification(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeVerification(); await disposeRemote() }
}
