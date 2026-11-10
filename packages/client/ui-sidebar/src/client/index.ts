/** Registers the sidebar shell and global panel navigation. */
import type {} from '@panedesk/dsh-client-product-analytics/client'
import type { Context as ClientContext } from '@panedesk/cordis'
import { createSnapshotStore } from '@panedesk/dsh-client-store'
import { resolveSlotLabel } from '@panedesk/dsh-client-ui-slots'
import type { MainPanelId } from '@panedesk/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@panedesk/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@panedesk/dsh-client-ui-renderer/client'
// Type-only: pulls the Session root standard-props merge.
import type {} from '@panedesk/dsh-client-ui-session/client'
import type { SidebarPanelMetadata, SidebarRootInjected } from './contract/slots.ts'
import { HeaderLeadingControls } from './HeaderLeadingControls.tsx'
import { SidebarRoot } from './SidebarRoot.tsx'
import { en, zh, type SidebarKey } from './locales.ts'

export type {
  SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps, SidebarFooterActionOwnerProps,
  SidebarPanelBadge, SidebarPanelIconOwnerProps, SidebarPanelMetadata, SidebarPanelRegistrationOptions,
  SidebarRootComponentProps, SidebarRootInjected, SidebarSectionOwnerProps, SidebarSettingsOwnerProps,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar controls and global panel copy. */
    sidebar: SidebarKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'sidebar'

/** List registration fields this shell reads; `badge` is stored only when supplied. */
interface SidebarPanelRegistration {
  id?: string
  order?: number
  label?: Parameters<typeof resolveSlotLabel>[0]
  badge?: { getSnapshot(): SidebarPanelMetadata['badge']; subscribe(fn: () => void): () => void }
}

/**
 * Click handler declared on a panel-list inject face. The slot ledger keeps
 * kind fields only, so a row that must not select a main panel returns this
 * from `inject` and the shell calls it instead.
 * @param face - the entry's inject return, when the entry declared one.
 * @returns a click handler, or undefined when the row selects its main panel.
 */
function panelActivate(face: Record<string, unknown> | undefined): (() => void) | undefined {
  const activate = face?.['activate']
  if (typeof activate !== 'function') return undefined
  return () => { Reflect.apply(activate, undefined, []) }
}

/** Whether two projected badge values are the same display fact. */
function sameBadge(left: SidebarPanelMetadata['badge'], right: SidebarPanelMetadata['badge']): boolean {
  if (left === right) return true
  if (left == null || right == null) return left == null && right == null
  return left.count === right.count && left.stale === right.stale && left.label === right.label
}

interface WorkspaceNavigation {
  startSession(workspaceId?: Parameters<SidebarRootInjected['startSession']>[0]): void
}

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'uiWorkspace', 'locale', 'shortcuts']

/** Registers the sidebar shell and its service callbacks.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar: dictionaries')
  const panels = createSnapshotStore<readonly SidebarPanelMetadata[]>([])
  /** Disposer of the live badge source per panel id; absent means the row registered none. */
  const badgeStops = new Map<MainPanelId, { source: NonNullable<SidebarPanelRegistration['badge']>; stop: () => void }>()
  const syncPanels = (): void => {
    const live = new Set<MainPanelId>()
    const next = ctx.slots.entriesOfSlot('sidebar.panellist').map((entry) => {
      const panel = entry.options as SidebarPanelRegistration
      // The list registration requires an id; StoredEntry erases the slot kind.
      const id = panel.id as MainPanelId
      live.add(id)
      const source = panel.badge
      const current = badgeStops.get(id)
      if (source === undefined) {
        current?.stop()
        badgeStops.delete(id)
      } else if (current?.source !== source) {
        current?.stop()
        badgeStops.set(id, { source, stop: source.subscribe(syncPanels) })
      }
      const row: SidebarPanelMetadata = { id, order: panel.order ?? 0, label: resolveSlotLabel(panel.label) ?? id }
      if (source !== undefined) row.badge = source.getSnapshot() ?? null
      const activate = panelActivate(entry.inject?.())
      if (activate !== undefined) row.activate = activate
      return row
    }).sort((a, b) => a.order - b.order)
    for (const [id, current] of badgeStops) {
      if (live.has(id)) continue
      current.stop()
      badgeStops.delete(id)
    }
    const previous = panels.getSnapshot()
    if (previous.length === next.length && previous.every((panel, index) => {
      const candidate = next[index] as SidebarPanelMetadata
      return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label
        && sameBadge(panel.badge, candidate.badge)
        && (panel.activate !== undefined) === (candidate.activate !== undefined)
    })) return
    panels.set(next)
  }
  ctx.effect(() => {
    const stopEntries = ctx.slots.subscribe('sidebar.panellist', syncPanels)
    return () => {
      stopEntries()
      for (const current of badgeStops.values()) current.stop()
      badgeStops.clear()
    }
  }, 'ui-sidebar: panel entries')
  ctx.effect(() => ctx.locale.subscribe(syncPanels), 'ui-sidebar: panel labels')

  const injectProps = (): SidebarRootInjected => ({
    // The shell's New Session button rides the Workspace UI's shared action
    // (the open Session's Workspace, then the recent Workspace).
    startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    selectPanel: (id) => {
      if (id === 'plugins' || id === 'schedules') ctx.get('productAnalytics')?.track('sidebar_menu_click', { menu_name: id === 'plugins' ? 'plugin' : 'cron' })
      ctx.layout.selectPanel(id)
    },
    hooks: { panels, shortcuts: ctx.shortcuts.catalog },
  })
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    locale: NS,
    children: {
      'sidebar.brand.mark': { kind: 'single', scope: 'root' },
      'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'sidebar.toggle.badge': { kind: 'single', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'sidebar.seats': { kind: 'single', scope: 'root' },
      'sidebar.settings': { kind: 'single', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
    inject: injectProps,
  }, SidebarRoot))
  // macOS desktop hides the collapsed sidebar entirely, so the open/New
  // Session controls move into the frame's window-chrome seat beside the
  // traffic lights; the occupant reuses the shell's injected actions, and
  // the AppFrame mounts the seat only while the column is fully hidden.
  ctx.slots.inject('shell.leading', () => ctx.slots.register({
    name: 'shell.leading',
    locale: NS,
    inject: injectProps,
  }, HeaderLeadingControls))
  syncPanels()
}
