/** Browser tool requests over the Desktop Host's existing Node IPC connection. */
import { randomUUID } from 'node:crypto'
import type { DesktopBrowserAction, DesktopBrowserResult, DesktopBrowserRequest } from './types.ts'

/**
 * Send one request; cancellation is forwarded to the desktop owner.
 * @param sessionId - calling Session.
 * @param command - validated tool action.
 * @param signal - tool cancellation.
 * @returns text and optional screenshot from the visible browser.
 */
export async function requestBrowser(sessionId: string, command: DesktopBrowserAction, signal: AbortSignal): Promise<DesktopBrowserResult> {
  if (!process.connected || process.send === undefined || process.env.DSH_DESKTOP_BROWSER_IPC !== '1') {
    return { text: 'Only available in the desktop app. / 只在桌面版可用。' }
  }
  signal.throwIfAborted()
  const request: DesktopBrowserRequest = { type: 'sidebar-browser', requestId: randomUUID(), sessionId, command }
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: DesktopBrowserResult): void => {
      process.off('message', receive)
      process.off('disconnect', disconnected)
      signal.removeEventListener('abort', abort)
      if (error !== undefined) reject(error)
      else resolve(result!)
    }
    const receive = (message: unknown): void => {
      if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'sidebar-browser-result'
        || !('requestId' in message) || message.requestId !== request.requestId) return
      const response = message as { requestId: string; error?: string; result?: DesktopBrowserResult }
      finish(response.error === undefined ? undefined : new Error(response.error), response.result)
    }
    const disconnected = (): void => { finish(new Error('Desktop browser disconnected')) }
    const abort = (): void => {
      process.send?.({ type: 'sidebar-browser-cancel', requestId: request.requestId })
      finish(new Error('Browser operation cancelled'))
    }
    process.on('message', receive)
    process.once('disconnect', disconnected)
    signal.addEventListener('abort', abort, { once: true })
    process.send!(request, error => { if (error !== null) finish(error) })
  })
}
