/** `sessionTab` namespace dictionaries. */

/** Simplified Chinese dictionary, the key-set source. */
export const zh = {
  'type.label': '会话',
  'menu.openRight': '在右栏打开',
  'menu.limit': '主区加右栏最多三个会话,请先关闭一个',
  'body.loading': '正在打开会话',
  'body.empty': '这个会话还没有钉住的条目',
  'body.error': '钉住的条目读取失败',
  'body.unavailable': '这个浏览器不能保存钉住的条目',
  'body.gone': '这条尚未载入,请先载入对应历史记录',
  'pin.list': '钉住的条目',
  'session.error': '会话打开失败,请重新打开页签',
  'pin.add': '钉住',
  'pin.remove': '取消钉住',
  'pin.saved': '已钉住,重启后仍在',
  'pin.failed': '钉住失败,没有保存',
  'pin.jump': '跳到这条',
} satisfies Record<string, string>

/** The session tab namespace key union. */
export type SessionTabKey = keyof typeof zh

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session tab copy: the right-sidebar page, the row menu item, and the pin. */
    sessionTab: SessionTabKey
  }
}

/** English dictionary, complete against the zh key set. */
export const en = {
  'type.label': 'Session',
  'menu.openRight': 'Open in the right sidebar',
  'menu.limit': 'The main area and the right sidebar hold three sessions; close one first',
  'body.loading': 'Opening the session',
  'body.empty': 'This session has no pinned entries',
  'body.error': 'The pinned entries could not be read',
  'body.unavailable': 'This browser cannot keep pinned entries',
  'body.gone': 'This entry is not loaded; load the matching history first',
  'pin.list': 'Pinned entries',
  'session.error': 'The session could not be opened; reopen this tab',
  'pin.add': 'Pin',
  'pin.remove': 'Unpin',
  'pin.saved': 'Pinned; it stays after a restart',
  'pin.failed': 'Pinning failed; nothing was saved',
  'pin.jump': 'Jump to this entry',
} satisfies Record<SessionTabKey, string>
