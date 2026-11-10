/**
 * Verification checklist plugin, browser half: a session-header pill and a
 * right-sidebar tab over submitted checklists and observed activity totals.
 */
import type { Context as ClientContext } from '@panedesk/cordis'
import type { ActivityCategory } from '@panedesk/dsh-activity-category/types'
import type {} from '@panedesk/dsh-verification-policy/remote'
import type { SessionId } from '@panedesk/dsh-session/types'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-sidebar-right/client'
import type {} from '@panedesk/dsh-client-ui-session/client'
import type {} from '@panedesk/dsh-api-workspace-controller/client'
import type {} from '@panedesk/dsh-tool-verification-checklist/client'
import type {} from '@panedesk/dsh-client-ui-settings-verification/client'
import type {} from '@panedesk/dsh-client-ui-subagent-tree/client'
import { VerificationChecklistAction, VerificationChecklistTab, type VerificationChecklistActions, type VerificationChecklistLabels } from './panel.tsx'
import { en, zh, type VerificationChecklistKey } from './locales.ts'

/** Stable implementation identity for the checklist tab body and pill. */
export const VERIFICATION_CHECKLIST_ID = '@panedesk/dsh-client-ui-verification-checklist'

/** Resource-address prefix for one session's checklist page. */
export const VERIFICATION_CHECKLIST_ADDRESS = 'dsh-resource://verificationchecklist/session/'

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Verification checklist copy. */
    verificationChecklist: VerificationChecklistKey
  }
}

/**
 * Address one session's verification checklist page.
 * @param sessionId - the on-screen session whose checklist the tab shows.
 * @returns canonical Sidebar resource address.
 */
export function verificationChecklistAddress(sessionId: SessionId): string {
  return `${VERIFICATION_CHECKLIST_ADDRESS}${encodeURIComponent(sessionId)}`
}

/**
 * Parse one canonical verification checklist resource address.
 * @param value - possible checklist resource address.
 * @returns the session id, or `undefined` for another or malformed resource.
 */
export function parseVerificationChecklistAddress(value: string): SessionId | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch (_invalidUrl) {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'verificationchecklist') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  try {
    return decodeURIComponent(parts[1] as string) as SessionId
  } catch (_invalidEncoding) {
    return undefined
  }
}

/** Required registries and the generated verification transport mount. */
export const inject = ['remote', 'slots', 'locale', 'resources', 'sidebarRightTabs', 'sidebarRight', 'sessions']

/**
 * Register the session-header pill and the right-sidebar tab over the shared verification Remote.
 * @param ctx - Client plugin lifetime and registries.
 * @returns Disposal of every registry contribution.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const ui = ctx.inject(['remote.verificationPolicy'], scope => {
    scope.effect(() => scope.locale.register('verificationChecklist', { en, zh }), 'verificationChecklist: locale')
    const t = scope.locale.bind('verificationChecklist')
    scope.effect(() => scope.sidebarRightTabs.register({
      id: VERIFICATION_CHECKLIST_ID,
      kind: 'verificationchecklist',
      patterns: [`${VERIFICATION_CHECKLIST_ADDRESS}**`],
      priority: 'extension',
      canOpen: address => parseVerificationChecklistAddress(address) !== undefined,
      title: () => t('title'),
    }), 'verificationChecklist: sidebar tab type')
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: VERIFICATION_CHECKLIST_ID,
      locale: 'verificationChecklist',
      inject: (): VerificationChecklistLabels => ({
        prohibit: async (sessionId, taskId, category: ActivityCategory) => {
          const result = await scope.remote.verificationPolicy.prohibitTaskCategories({ sessionId, taskId, categories: [category] })
          if (!result.ok) throw result.error
        },
      }),
    }, VerificationChecklistTab))
    scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
      name: 'conversation.session.header.actions',
      id: 'verification-checklist',
      order: 16,
      locale: 'verificationChecklist',
      inject: (): VerificationChecklistActions => ({
        open: (sessionId) => { scope.sidebarRight.openResourceIn(sessionId, verificationChecklistAddress(sessionId), { kind: 'verificationchecklist' }) },
      }),
    }, VerificationChecklistAction))
  })
  try { await ui } catch (error) { await ui.dispose(); throw error }
  return async () => { await ui.dispose() }
}
