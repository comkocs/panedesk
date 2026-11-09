/** Prepare the visible Session tab before main-process browser automation. */
import type { Context } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session/types'
import type {} from '@panedesk/dsh-client-ui-workspace/client'
import type {} from '@panedesk/dsh-client-ui-sidebar-right/client'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '../../types.ts'

function mountedElement(selector: string, signal: AbortSignal, visible = false): Promise<Element> {
  signal.throwIfAborted()
  const find = (): Element | undefined => [...document.querySelectorAll(selector)].find(element => !visible || element.checkVisibility({ checkVisibilityCSS: true }))
  const present = find()
  if (present !== undefined) return Promise.resolve(present)
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { observer.disconnect(); signal.removeEventListener('abort', abort) }
    const abort = (): void => { cleanup(); reject(new Error('Browser operation cancelled')) }
    const observer = new MutationObserver(() => {
      const element = find()
      if (element !== undefined) { cleanup(); resolve(element) }
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** @param ctx - declared navigation services. @param bridge - Desktop transport. @returns unregister callback. */
export function installBrowserAutomation(ctx: Context, bridge: DesktopBrowserBridge): () => void {
  const pending = new Map<string, AbortController>()
  return bridge.onPrepare(async ({ requestId, sessionId, command }) => {
    const controller = new AbortController()
    pending.set(requestId, controller)
    const { signal } = controller
    try {
    const id = sessionId as SessionId
    ctx.uiWorkspace.openSession(id)
    const root = `[data-sidebar-right-session="${CSS.escape(id)}"]`
    await mountedElement(`${root}:not([hidden])`, signal)
    let tabs = ctx.sidebarRight.tabsIn(id).filter(tab => tab.kind === 'browser')
    if (tabs.length === 0) {
      ctx.sidebarRight.openTabIn(id, 'browser')
      tabs = ctx.sidebarRight.tabsIn(id).filter(tab => tab.kind === 'browser')
    }
    const active = ctx.sidebarRight.active()
    const tab = command.action === 'switch' ? tabs.find(tab => tab.id === command.tabId)
      : tabs.find(tab => tab.id === active?.id) ?? tabs[0]
    if (tab === undefined) throw new Error('Browser tab not found')
    ctx.sidebarRight.focus(tab.id)
    if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
    if (command.action === 'tabs') {
      return { text: JSON.stringify(tabs.map(tab => {
        const frame = document.querySelector(`${root} [data-sidebar-right-tab="${CSS.escape(tab.id)}"] webview`)
        return { tabId: tab.id, title: frame?.getAttribute('aria-label') ?? tab.title, selected: tab.id === ctx.sidebarRight.active()?.id }
      })) }
    }
    const element = await mountedElement(`${root} [data-sidebar-right-tab="${CSS.escape(tab.id)}"] webview[data-sidebar-browser-ready="true"]`, signal, true)
    return { lease: element.getAttribute('name') as DesktopBrowserLeaseId, text: `Selected browser tab ${tab.id}` }
    } finally { pending.delete(requestId) }
  }, requestId => { pending.get(requestId)?.abort() })
}
