/**
 * Session tab plugin, browser half: a right-sidebar page type opened from a
 * session row's menu, and a pin on each finalized assistant message. A pin is a
 * bookmark kept in the browser; it never changes what a model sees.
 * @module @panedesk/dsh-client-ui-session-tab/client
 */
import type { Context as ClientContext } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session/types'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-chat/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-session/client'
import type {} from '@panedesk/dsh-client-ui-sidebar-right/client'
import type {} from '@panedesk/dsh-client-ui-workspace/client'
import { SESSION_KIND, SESSION_TAB_ID, sessionTabDefinition } from './definition.ts'
import { en, zh } from './locales.ts'
import { OpenInRightMenuItem } from './OpenInRightMenuItem.tsx'
import { PinAction } from './PinAction.tsx'
import { addPin, browserPinStorage, readPins, removePin, type SessionPin } from './pins.ts'
import { createSnapshotStore } from '@panedesk/dsh-client-store'
import { SessionTabBody } from './SessionTabBody.tsx'
import { SessionConversation } from './conversation.tsx'
import { sessionTabProvider } from './resource.ts'
import type {} from '@panedesk/dsh-api-session-controller/client'
import type {} from '@panedesk/dsh-client-resources/client'

export type {} from './resource.ts'
export type {} from './session.ts'
export type { SessionTabKey } from './locales.ts'
export type { OpenInRightInjected, OpenInRightMenuItemProps } from './OpenInRightMenuItem.tsx'
export type { PinActionInjected, PinActionProps } from './PinAction.tsx'
export type { PinRead, SessionPin } from './pins.ts'
export type { SessionTabBodyProps, SessionTabInjected } from './SessionTabBody.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'sessionTab'

/** Main area plus the right sidebar's two panes: one screen holds at most this many sessions. */
const SESSION_LIMIT = 3

/** Required services: slots, copy, the tab registry, and the right sidebar. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'resources']

/** Session tabs already open in the right sidebar, counted from the open-tab inventory. */
function openSessionTabs(ctx: ClientContext): number {
  const mounted = ctx.sidebarRight.mounted.getSnapshot()
  if (mounted === undefined) return 0
  return ctx.sidebarRight.openTabs.getSnapshot()
    .filter(tab => (tab.kind === SESSION_KIND || tab.kind === 'subagentchat') && tab.sessionId === mounted).length
}

/**
 * Client plugin body: the tab type, the row menu item, and the pin action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-tab: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register(sessionTabDefinition(t)), 'ui-session-tab: session type')

  ctx.effect(() => ctx.resources.register(sessionTabProvider(ctx.sessions)), 'ui-session-tab: retained sessions')
  ctx.effect(() => ctx.slots.inject('sidebar.session.conversation', () => ctx.slots.register({
    name: 'sidebar.session.conversation',
  }, SessionConversation)), 'ui-session-tab: conversation')

  const storage = () => browserPinStorage()
  const pinState = createSnapshotStore(readPins(storage()))
  ctx.effect(() => {
    const refresh = (): void => { pinState.set(readPins(storage())) }
    window.addEventListener('storage', refresh)
    return () => { window.removeEventListener('storage', refresh) }
  }, 'ui-session-tab: browser pin changes')
  const pinsOf = (sessionId: SessionId): readonly SessionPin[] => {
    const read = readPins(storage())
    return read.status === 'ready' ? read.pins.filter(pin => pin.sessionId === sessionId) : []
  }

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: SESSION_TAB_ID,
    locale: NS,
    children: { 'sidebar.session.conversation': { kind: 'single', scope: 'session' } },
    inject: () => ({
      hooks: { pins: pinState },
      // The transcript marks a message by its id only when a viewer has rendered it.
      // A pin whose message is not on screen reports that; it does not invent a scroll target.
      jump: (root: HTMLElement, messageId: string): boolean => {
        const target = root.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
        if (!(target instanceof HTMLElement)) return false
        target.scrollIntoView({ block: 'center' })
        return true
      },
    }),
  }, SessionTabBody)), 'ui-session-tab: session tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'open-in-right',
    order: 500,
    locale: NS,
    inject: () => ({
      open: (sessionId: SessionId): boolean => {
        // The main area already holds one session, so two right-sidebar panes fill the screen.
        if (openSessionTabs(ctx) >= SESSION_LIMIT - 1) return false
        ctx.sidebarRight.openTab(SESSION_KIND, { params: { sessionId }, preferNewPane: true })
        return true
      },
    }),
  }, OpenInRightMenuItem)), 'ui-session-tab: open in the right sidebar')

  ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'pin',
    order: 20,
    locale: NS,
    inject: (sessionId: SessionId) => ({
      hooks: { pins: pinState },
      toggle: (messageId: string): 'pinned' | 'unpinned' | 'failed' => {
        const store = storage()
        if (store === undefined) return 'failed'
        const pinned = pinsOf(sessionId).some(pin => pin.messageId === messageId)
        try {
          if (pinned) removePin(store, sessionId, messageId)
          else addPin(store, { sessionId, messageId, pinnedAt: Date.now() })
        } catch (error) {
          console.error('Pin write failed:', error)
          return 'failed'
        }
        pinState.set(readPins(store))
        return pinned ? 'unpinned' : 'pinned'
      },
    }),
  }, PinAction)), 'ui-session-tab: pin action')
}
