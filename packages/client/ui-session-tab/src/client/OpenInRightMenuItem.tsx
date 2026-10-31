/** Session-row menu item that opens the row's session as a right-sidebar tab. */
import { useState } from 'react'
import { IconPanelLeftOutlineRegular, MenuItemButton } from '@panedesk/dsh-client-ui-primitives'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'

/** What the menu item needs from its registration. */
export interface OpenInRightInjected {
  /**
   * Open one session in the right sidebar.
   * @param sessionId - the row's session.
   * @returns false when the screen already holds three sessions.
   */
  open(this: void, sessionId: SessionId): boolean
}

/** Props of the menu item: the row slot, this namespace, and the opener. */
export type OpenInRightMenuItemProps =
  & PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<'sessionTab'>
  & OpenInRightInjected

/**
 * The "open in the right sidebar" row of a session's menu.
 * @param props - the row, menu dismissal, and the opener.
 * @returns the menu item, or the limit line when three sessions are already open.
 */
export function OpenInRightMenuItem({ sessionId, useMenuOpenState, open, t }: OpenInRightMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  const [blocked, setBlocked] = useState(false)
  if (blocked) return <span role="status">{t('menu.limit')}</span>
  return (
    <MenuItemButton icon={<IconPanelLeftOutlineRegular />} onSelect={() => {
      if (!open(sessionId)) { setBlocked(true); return }
      setMenuOpen(false)
    }}>
      {t('menu.openRight')}
    </MenuItemButton>
  )
}
