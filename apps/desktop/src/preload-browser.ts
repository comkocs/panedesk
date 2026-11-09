/** Lease-scoped browser operations and one main-process event subscription per window. */
import { ipcRenderer } from 'electron'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopBrowserRequest } from '@panedesk/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns browser operations that expose neither IPC nor Electron objects. */
export function createDesktopBrowserBridge(): DesktopBrowserBridge {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(url: string) => void>>()
  ipcRenderer.on(DESKTOP_IPC.browserOpenRequested, (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null || !('lease' in request) || !('url' in request)
      || typeof request.lease !== 'string' || typeof request.url !== 'string') return
    const callbacks = listeners.get(request.lease as DesktopBrowserLeaseId)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try { callback(request.url) }
      catch (error) { console.error('Desktop browser link handler failed', error) }
    }
  })
  return {
    acquire: workspace => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace) as ReturnType<DesktopBrowserBridge['acquire']>,
    release: lease => ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease) as Promise<void>,
    onPrepare(handler, cancelRequest) {
      const pending = new Set<string>()
      const prepare = (_event: Electron.IpcRendererEvent, request: DesktopBrowserRequest): void => {
        pending.add(request.requestId)
        void handler(request).then(
          result => ipcRenderer.invoke(DESKTOP_IPC.browserPrepared, request.requestId, { result }),
          (error: unknown) => ipcRenderer.invoke(DESKTOP_IPC.browserPrepared, request.requestId, { error: error instanceof Error ? error.message : String(error) }),
        ).catch((error: unknown) => { console.error('Desktop browser preparation failed', error) })
          .finally(() => { pending.delete(request.requestId) })
      }
      const cancel = (_event: Electron.IpcRendererEvent, requestId: string): void => { cancelRequest(requestId) }
      ipcRenderer.on(DESKTOP_IPC.browserPrepare, prepare)
      ipcRenderer.on(DESKTOP_IPC.browserCancel, cancel)
      return () => {
        ipcRenderer.off(DESKTOP_IPC.browserPrepare, prepare)
        ipcRenderer.off(DESKTOP_IPC.browserCancel, cancel)
        for (const requestId of pending) cancelRequest(requestId)
      }
    },
    onOpenRequested(lease, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
      }
    },
  }
}
