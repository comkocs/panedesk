/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@panedesk/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Actions exposed to agents; coordinates are viewport CSS pixels. */
export type DesktopBrowserAction =
  | { readonly action: 'navigate'; readonly url: string }
  | { readonly action: 'read' | 'screenshot' | 'tabs' }
  | { readonly action: 'click'; readonly x: number; readonly y: number }
  | { readonly action: 'type'; readonly text: string }
  | { readonly action: 'scroll'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | { readonly action: 'switch'; readonly tabId: string }

/** One correlated Host request carried over the existing Node IPC channel. */
export interface DesktopBrowserRequest {
  readonly type: 'sidebar-browser'
  readonly requestId: string
  readonly sessionId: string
  readonly command: DesktopBrowserAction
}

/** Text and optional PNG bytes before durable attachment storage. */
export interface DesktopBrowserResult {
  readonly text: string
  readonly screenshot?: string
}

/** Renderer preparation returns the selected page or the Session's tab inventory. */
export interface DesktopBrowserPrepared {
  readonly lease?: DesktopBrowserLeaseId
  readonly text: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param handler - opens the calling Session's tab. @param cancel - cancels an identified request. @returns unregister callback. */
  onPrepare(handler: (request: DesktopBrowserRequest) => Promise<DesktopBrowserPrepared>, cancel: (requestId: string) => void): () => void
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
