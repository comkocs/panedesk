/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation, DesktopBrowserRequest, DesktopBrowserPrepared, DesktopBrowserResult } from '@panedesk/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  private readonly preparations = new Map<string, {
    readonly owner: WebContents
    readonly resolve: (value: DesktopBrowserPrepared) => void
    readonly reject: (error: Error) => void
  }>()

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined) {}

  /**
   * Reserve one guest in a workspace's process-lifetime partition.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, attached: false })
    return { lease, partition }
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    lease.releaseInput?.()
    this.leases.delete(key)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      if (guest.debugger.isAttached()) guest.debugger.detach()
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease: DesktopBrowserLeaseId | undefined
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = (url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : '') as DesktopBrowserLeaseId
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        guest.once('destroyed', () => { lease.releaseInput?.(); this.leases.delete(id) })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          owner.send(DESKTOP_IPC.browserOpenRequested, request)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = (): void => {
      for (const pending of this.preparations.values()) {
        if (pending.owner === owner) pending.reject(new Error('Browser window closed'))
      }
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  /** @param owner - authenticated window. @param requestId - echoed request. @param response - prepared page or failure. */
  prepared(owner: WebContents, requestId: string, response: { result: DesktopBrowserPrepared; error?: string }): void {
    const pending = this.preparations.get(requestId)
    if (pending?.owner !== owner) return
    if (response.error === undefined) pending.resolve(response.result)
    else pending.reject(new Error(response.error))
  }

  /** @param owner - product window. @param request - Session action. @param signal - Host cancellation. @returns visible browser output. */
  async automate(owner: WebContents, request: DesktopBrowserRequest, signal: AbortSignal): Promise<DesktopBrowserResult> {
    signal.throwIfAborted()
    const cancel = (): void => {
      owner.send(DESKTOP_IPC.browserCancel, request.requestId)
      this.preparations.get(request.requestId)?.reject(new Error('Browser operation cancelled'))
    }
    signal.addEventListener('abort', cancel, { once: true })
    let prepared: DesktopBrowserPrepared
    try {
      prepared = await new Promise<DesktopBrowserPrepared>((resolve, reject) => {
        this.preparations.set(request.requestId, { owner, resolve, reject })
        owner.send(DESKTOP_IPC.browserPrepare, request)
      })
    } finally {
      signal.removeEventListener('abort', cancel)
      this.preparations.delete(request.requestId)
    }
    signal.throwIfAborted()
    if (request.command.action === 'tabs') return { text: prepared.text }
    const lease = prepared.lease === undefined ? undefined : this.leases.get(prepared.lease)
    if (lease?.owner !== owner || lease.guest === undefined) throw new Error('Browser page is no longer open')
    const guest = lease.guest
    if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
    const command = request.command
    const send = async (method: string, params?: object): Promise<any> => { // Electron's CDP API has no typed response map.
      signal.throwIfAborted()
      const cancel = (): void => { if (!guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach() }
      signal.addEventListener('abort', cancel, { once: true })
      try { return await guest.debugger.sendCommand(method, params) }
      finally { signal.removeEventListener('abort', cancel) }
    }
    switch (command.action) {
      case 'navigate': {
        const url = URL.canParse(command.url) ? command.url : `https://${command.url}`
        if (!this.allowedNavigation(url)) throw new Error('Browser navigation requires an HTTP(S) page outside the application')
        const result = await send('Page.navigate', { url }) as { errorText?: string }
        if (result.errorText !== undefined) throw new Error(result.errorText)
        if (guest.isLoadingMainFrame()) await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            guest.off('did-stop-loading', loaded)
            guest.off('destroyed', closed)
            signal.removeEventListener('abort', aborted)
          }
          const loaded = (): void => { cleanup(); resolve() }
          const closed = (): void => { cleanup(); reject(new Error('Browser page closed')) }
          const aborted = (): void => { cleanup(); guest.stop(); reject(new Error('Browser operation cancelled')) }
          guest.once('did-stop-loading', loaded)
          guest.once('destroyed', closed)
          signal.addEventListener('abort', aborted, { once: true })
          if (signal.aborted) aborted()
        })
        break
      }
      case 'read': {
        const result = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }) as { result: { value: string }; exceptionDetails?: object }
        if (result.exceptionDetails !== undefined) throw new Error('Could not read page text')
        return { text: `${guest.getTitle()}\n${guest.getURL()}\n${result.result.value}` }
      }
      case 'screenshot': {
        const result = await send('Page.captureScreenshot', { format: 'png' }) as { data: string }
        const size = await send('Runtime.evaluate', { expression: 'JSON.stringify({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})', returnByValue: true }) as { result: { value: string } }
        return { text: `${guest.getTitle()}\n${guest.getURL()}\nViewport CSS pixels: ${size.result.value}`, screenshot: result.data }
      }
      case 'click':
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: command.x, y: command.y, button: 'left', clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: command.x, y: command.y, button: 'left', clickCount: 1 })
        break
      case 'type':
        await send('Input.insertText', { text: command.text })
        break
      case 'scroll':
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: command.x, y: command.y, deltaX: command.deltaX, deltaY: command.deltaY })
        break
      case 'switch':
        break
    }
    signal.throwIfAborted()
    return { text: `${guest.getTitle()}\n${guest.getURL()}` }
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
