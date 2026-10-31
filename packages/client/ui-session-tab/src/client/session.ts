/** Which session one right-sidebar session tab was opened for. */
import type { SessionId } from '@panedesk/dsh-session/types'
import type { SidebarRightNavigationParams, SidebarRightTabParamsMap } from '@panedesk/dsh-client-ui-sidebar-right/client'

declare module '@panedesk/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** One conversation, named by the session the row menu opened. */
    session: { sessionId: SessionId }
  }
}

/**
 * Narrow one tab's navigation parameters to the session this type opens.
 * @param params - the tab record's navigation parameters.
 * @returns the session the tab shows, or undefined for another type's parameters.
 */
export function sessionTabParams(
  params: SidebarRightNavigationParams,
): SidebarRightTabParamsMap['session'] | undefined {
  if (params === undefined || !('sessionId' in params) || typeof params.sessionId !== 'string') return undefined
  return { sessionId: params.sessionId }
}
