/** Stage one of this package's registration: what the `session` tab type is. */
import type { SidebarRightTabDefinition } from '@panedesk/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@panedesk/dsh-client-locale/client'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const SESSION_KIND = 'session'

/** This implementation's identity, and the key its body registers under. */
export const SESSION_TAB_ID = '@panedesk/dsh-client-ui-session-tab'

/**
 * The session type's registry definition. It is a page opened by kind, so it claims no address
 * and stays off the guide: the session row menu is its only entrance.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function sessionTabDefinition(t: TranslateNS<'sessionTab'>): SidebarRightTabDefinition {
  return {
    id: SESSION_TAB_ID,
    kind: SESSION_KIND,
    multiple: true,
    priority: 'builtin',
    title: () => t('type.label'),
  }
}
