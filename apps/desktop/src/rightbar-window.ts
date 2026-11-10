/** Main-window geometry for sidebars that keep the main Conversation width. */
import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'

/** Own the temporary window expansion until the right sidebar closes. */
export class RightbarWindow {
  private width = 0
  private original: { bounds: Rectangle; contentWidth: number } | undefined

  /** @param window - main application window whose renderer reports sidebar width. */
  constructor(private readonly window: BrowserWindow) {
    window.on('maximize', () => { this.sync() })
    window.on('unmaximize', () => { this.sync() })
    window.on('enter-full-screen', () => { this.sync() })
    window.on('leave-full-screen', () => { this.sync() })
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.setWidth(0)
    })
    window.webContents.on('render-process-gone', () => { this.setWidth(0) })
  }

  /** @param width - sidebar width in CSS pixels; zero restores the original window. */
  setWidth(width: number): void {
    this.width = width
    this.sync()
  }

  private sync(): void {
    const window = this.window
    let mainWidth: number | null = null
    if (!window.isMaximized() && !window.isFullScreen()) {
      if (this.width === 0) {
        if (this.original !== undefined) {
          const { x, width } = this.original.bounds
          window.setBounds({ x, width })
          this.original = undefined
        }
      } else {
        const zoom = window.webContents.getZoomFactor()
        this.original ??= { bounds: window.getBounds(), contentWidth: window.getContentBounds().width / zoom }
        const { bounds, contentWidth } = this.original
        const workArea = screen.getDisplayMatching(bounds).workArea
        const width = bounds.width + Math.round(this.width * zoom)
        window.setBounds({ x: Math.min(bounds.x, workArea.x + workArea.width - width), width })
        mainWidth = contentWidth
      }
    }
    window.webContents.send(DESKTOP_IPC.rightbarGeometry, mainWidth)
  }
}
