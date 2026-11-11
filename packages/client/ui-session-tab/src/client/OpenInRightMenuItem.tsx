/** Session-row menu item that opens the row's session as a floating panel. */
import { IconPanelLeftOutlineRegular, MenuItemButton } from '@panedesk/dsh-client-ui-primitives'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'

/** What the menu item needs from its registration. */
export interface OpenInRightInjected {
  /**
   * Open or raise one floating session, reusing a visible conversation place at the limit.
   * @param sessionId - the row's session.
   */
  open(this: void, sessionId: SessionId): void
}

/** Props of the menu item: the row slot, this namespace, and the opener. */
export type OpenInRightMenuItemProps =
  & PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<'sessionTab'>
  & OpenInRightInjected

/**
 * The floating-panel entry in a session's menu.
 * @param props - the row, menu dismissal, and the opener.
 * @returns the menu item.
 */
export function OpenInRightMenuItem({ sessionId, useMenuOpenState, open, t }: OpenInRightMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton icon={<IconPanelLeftOutlineRegular />} onSelect={() => {
      open(sessionId)
      setMenuOpen(false)
    }}>
      {t('menu.openRight')}
    </MenuItemButton>
  )
}
