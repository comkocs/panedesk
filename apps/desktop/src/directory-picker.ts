/** Window-owned file selection, text export, and workspace directory dialogs for the local Desktop renderer. */

import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { DESKTOP_IPC, assertDesktopSender } from './ipc.ts'

/**
 * Install application-lifetime file selection, text export, and directory picker IPC handlers.
 * @param getWindow - Current local application window; shell pages and subframes cannot open dialogs.
 */
export function installDesktopDirectoryPicker(getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle(DESKTOP_IPC.textExport, async (event, input: { name: string; text: string }) => {
    const window = getWindow()
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('panedesk desktop: rejected text export from an unowned renderer')
    }
    assertDesktopSender(event, ['app'])
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    const { canceled, filePath } = await dialog.showSaveDialog(window, { defaultPath: basename(input.name) })
    if (canceled || filePath === undefined) return null
    await writeFile(filePath, input.text, 'utf8')
    return basename(filePath)
  })
  for (const channel of [DESKTOP_IPC.directoryPick, DESKTOP_IPC.filePick]) {
    const pending = new WeakMap<BrowserWindow, Promise<string | null>>()
    ipcMain.handle(channel, async (event) => {
      const window = getWindow()
      if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('panedesk desktop: rejected directory picker from an unowned renderer')
      }
      assertDesktopSender(event, ['app'])
      const existing = pending.get(window)
      if (existing !== undefined) return existing
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      const result = dialog.showOpenDialog(window, {
        properties: channel === DESKTOP_IPC.filePick ? ['openFile'] : ['openDirectory', 'createDirectory'],
      }).then(
        ({ canceled, filePaths }) => window.isDestroyed() || canceled ? null : filePaths[0] ?? null,
      ).finally(() => { pending.delete(window) })
      pending.set(window, result)
      return result
    })
  }
}
