/** One main conversation and the visible docked or floating conversation pages share three places. */

interface SessionLayout {
  readonly expanded: boolean
  readonly nodes: Readonly<Record<string, { readonly kind: string; readonly host?: string; readonly activeTabId?: string | undefined }>>
  readonly tabs: Readonly<Record<string, { readonly kind: string }>>
}

/**
 * Check the final layout, excluding inactive tabs and collapsed dock panes.
 * @param layout - complete candidate layout for the foreground Session.
 * @returns whether its visible conversations fit beside the main conversation.
 */
export function fitsSessionBudget(layout: SessionLayout): boolean {
  let visible = 1
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== 'pane' || (node.host === 'dock' && !layout.expanded)) continue
    const kind = node.activeTabId === undefined ? undefined : layout.tabs[node.activeTabId]?.kind
    if (kind === 'session' || kind === 'subagentchat') visible += 1
  }
  return visible <= 3
}
