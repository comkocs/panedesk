/**
 * Project trace plugin, browser half: workspace recording switches and a
 * right-sidebar tab for items, activity, and decisions.
 */
import type { Context as ClientContext } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session/types'
import type {} from '@panedesk/dsh-trace-store/remote'
import type { DecisionId, DecisionRevision, ItemId, ProjectId, ReferenceContent, ReferenceId, TimelinePage, TraceItem, TraceStatus } from '@panedesk/dsh-trace-store/types'
import { remoteErrorOf, type RemoteResult } from '@panedesk/dsh-typert-protocol'
import type { WorkspaceId } from '@panedesk/dsh-workspace/types'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-sidebar-right/client'
import type {} from '@panedesk/dsh-client-ui-session/client'
import type {} from '@panedesk/dsh-api-workspace-controller/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import { TraceAction, TracePanel } from './panel.tsx'
import { TraceSettingsRow } from './settings.tsx'
import { en, zh, type TraceKey } from './locales.ts'
import { referenceText } from './format.ts'

/** Stable implementation identity for the trace tab body. */
export const TRACE_PANEL_ID = '@panedesk/dsh-client-ui-trace'

/** Resource-address prefix for one session's trace page. */
export const TRACE_ADDRESS = 'dsh-resource://trace/session/'

/** One workspace's recording switches, read through the resource provider. */
export interface TraceStatusResource { status: TraceStatus }
/** Items in one workspace project. */
export interface TraceItemsResource { items: readonly TraceItem[] }
/** One item's timeline, or unassigned activity when the address names none. */
export interface TraceTimelineResource { page: TimelinePage }
/** Current decision revisions in one workspace project. */
export interface TraceDecisionsResource { rows: readonly DecisionRevision[] }
/** Every stored revision of one decision. */
export interface TraceHistoryResource { rows: readonly DecisionRevision[] }

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Project trace copy. */
    trace: TraceKey
  }
  interface ResourceProtocolMap {
    trace: TraceStatusResource
    traceitems: TraceItemsResource
    tracetimeline: TraceTimelineResource
    tracedecisions: TraceDecisionsResource
    tracehistory: TraceHistoryResource
  }
}

/** Actions the settings row uses. Every call goes through the trace service. */
export interface TraceSettingsActions {
  /** Turn recording on. */
  enable(this: void, workspaceId: WorkspaceId): Promise<RemoteResult<TraceStatus>>
  /** Turn recording off. */
  disable(this: void, workspaceId: WorkspaceId): Promise<RemoteResult<TraceStatus>>
  /** Reuse an existing project record. */
  associate(this: void, workspaceId: WorkspaceId, projectId: ProjectId): Promise<RemoteResult<TraceStatus>>
  /** Set strict mode and its planning window. */
  setStrict(this: void, workspaceId: WorkspaceId, strict: boolean, plannerSessionId: SessionId | null): Promise<RemoteResult<TraceStatus>>
}

/** Actions the session-header pill uses. */
export interface TraceOpenActions {
  /** Open this session's items page in the right sidebar. */
  open(this: void, sessionId: SessionId): void
}

/** Actions the items panel uses. */
export interface TracePanelActions {
  /** Create an item from this window. */
  createItem(this: void, workspaceId: WorkspaceId, title: string, sessionId: SessionId): Promise<RemoteResult<TraceItem>>
  /** Close an open item. */
  closeItem(this: void, workspaceId: WorkspaceId, itemId: ItemId): Promise<RemoteResult<void>>
  /** Move unassigned events onto an item. */
  assign(this: void, workspaceId: WorkspaceId, itemId: ItemId, eventIds: number[]): Promise<RemoteResult<void>>
  /** Read one stored reference. */
  reference(this: void, workspaceId: WorkspaceId, referenceId: ReferenceId): Promise<RemoteResult<ReferenceContent>>
  /** Revert one current decision. */
  revert(this: void, workspaceId: WorkspaceId, decisionId: DecisionId): Promise<RemoteResult<DecisionRevision>>
  /** Confirm one pending proposal. */
  confirm(this: void, workspaceId: WorkspaceId, decisionId: DecisionId, revision: number): Promise<RemoteResult<DecisionRevision>>
  /** Reject one pending proposal. */
  reject(this: void, workspaceId: WorkspaceId, decisionId: DecisionId, revision: number): Promise<RemoteResult<DecisionRevision>>
  /** Open the workspace switches. */
  openSettings(this: void): void
}

/**
 * Address one session's trace page.
 * @param sessionId - the on-screen session whose workspace the tab shows.
 * @returns canonical Sidebar resource address.
 */
export function traceAddress(sessionId: SessionId): string {
  return `${TRACE_ADDRESS}${encodeURIComponent(sessionId)}`
}

/**
 * Parse one canonical trace resource address.
 * @param value - possible trace resource address.
 * @returns the session id, or `undefined` for another or malformed resource.
 */
export function parseTraceAddress(value: string): SessionId | undefined {
  let url: URL
  try { url = new URL(value) } catch (_invalidUrl) { return undefined }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'trace') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  try { return decodeURIComponent(parts[1] as string) as SessionId } catch (_invalidEncoding) { return undefined }
}

/** Required registries and the shared trace transport. */
export const inject = ['remote', 'slots', 'locale', 'resources', 'sidebarRightTabs', 'sidebarRight', 'settingsNavigation']

/** Register the settings row and the right-sidebar tab over the shared trace Remote.
 * @param ctx - Client plugin lifetime and registries.
 * @returns Disposal of every registry contribution.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const ui = ctx.inject(['remote.traceStore'], scope => {
    scope.effect(() => scope.locale.register('trace', { en, zh }), 'trace: locale')
    const t = scope.locale.bind('trace')
    const request = (workspaceId: WorkspaceId) => ({ workspaceId })
    const workspaceOf = (address: string): WorkspaceId => decodeURIComponent(new URL(address).pathname.slice(1)) as WorkspaceId
    scope.effect(() => scope.resources.register<'trace'>({
      protocol: 'trace', async *open(address): AsyncIterable<RemoteResult<TraceStatusResource>> {
        const result = await scope.remote.traceStore.status(request(workspaceOf(address)))
        yield result.ok ? { ok: true, value: { status: result.value } } : result
      },
    }), 'trace: status resource')
    scope.effect(() => scope.resources.register<'traceitems'>({
      protocol: 'traceitems', async *open(address): AsyncIterable<RemoteResult<TraceItemsResource>> {
        const result = await scope.remote.traceStore.listItems(request(workspaceOf(address)))
        yield result.ok ? { ok: true, value: { items: result.value } } : result
      },
    }), 'trace: items resource')
    scope.effect(() => scope.resources.register<'tracetimeline'>({
      protocol: 'tracetimeline', async *open(address): AsyncIterable<RemoteResult<TraceTimelineResource>> {
        const url = new URL(address)
        const workspaceId = decodeURIComponent(url.pathname.slice(1)) as WorkspaceId
        const item = url.searchParams.get('item')
        const result = await scope.remote.traceStore.timeline({ ...request(workspaceId), itemId: item === null ? null : Number(item) })
        if (result.ok) {
          for (const event of result.value.events) {
            if (event.type !== 'assistant/message' && event.type !== 'tool/call') continue
            const ref = result.value.refs.find(row => row.eventId === event.id && row.kind === 'session-slice')!
            const content = await scope.remote.traceStore.readReference({ workspaceId, referenceId: ref.id })
            if (!content.ok) { yield content; return }
            event.payload = JSON.stringify({ summary: referenceText(content.value).slice(0, 30) })
          }
        }
        yield result.ok ? { ok: true, value: { page: result.value } } : result
      },
    }), 'trace: timeline resource')
    scope.effect(() => scope.resources.register<'tracedecisions'>({
      protocol: 'tracedecisions', async *open(address, { signal }): AsyncIterable<RemoteResult<TraceDecisionsResource>> {
        try {
          for await (const rows of scope.remote.traceStore.followDecisions(request(workspaceOf(address)), signal)) {
            yield { ok: true, value: { rows } }
          }
        } catch (error) {
          if (signal.aborted) return
          const failure = remoteErrorOf(error)
          if (failure === undefined) throw error
          yield { ok: false, error: failure }
        }
      },
    }), 'trace: decisions resource')
    scope.effect(() => scope.resources.register<'tracehistory'>({
      protocol: 'tracehistory', async *open(address): AsyncIterable<RemoteResult<TraceHistoryResource>> {
        const url = new URL(address)
        const result = await scope.remote.traceStore.decisionHistory({ ...request(workspaceOf(address)), decisionId: decodeURIComponent(url.searchParams.get('decision') ?? '') as DecisionId })
        yield result.ok ? { ok: true, value: { rows: result.value } } : result
      },
    }), 'trace: history resource')
    scope.slots.inject('settings.panedesk.item', () => scope.slots.register({
      name: 'settings.panedesk.item', id: 'trace-recording', order: 22, locale: 'trace',
      inject: (): TraceSettingsActions => ({
        enable: workspaceId => scope.remote.traceStore.enable(request(workspaceId)),
        disable: workspaceId => scope.remote.traceStore.disable(request(workspaceId)),
        associate: (workspaceId, projectId) => scope.remote.traceStore.associateProject({ ...request(workspaceId), projectId }),
        setStrict: (workspaceId, strict, plannerSessionId) => scope.remote.traceStore.setStrict({ ...request(workspaceId), strict, plannerSessionId }),
      }),
    }, TraceSettingsRow))
    scope.effect(() => scope.sidebarRightTabs.register({
      id: TRACE_PANEL_ID, kind: 'trace', patterns: [`${TRACE_ADDRESS}**`], priority: 'extension',
      canOpen: address => parseTraceAddress(address) !== undefined,
      title: () => t('title'),
    }), 'trace: sidebar tab type')
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: TRACE_PANEL_ID, locale: 'trace',
      inject: (): TracePanelActions => ({
        createItem: (workspaceId, title, sessionId) => scope.remote.traceStore.createItem({ ...request(workspaceId), sessionId, title }),
        closeItem: (workspaceId, itemId) => scope.remote.traceStore.closeItem({ ...request(workspaceId), itemId }),
        assign: (workspaceId, itemId, eventIds) => scope.remote.traceStore.assignEvents({ ...request(workspaceId), itemId, eventIds }),
        reference: (workspaceId, referenceId) => scope.remote.traceStore.readReference({ ...request(workspaceId), referenceId }),
        revert: (workspaceId, decisionId) => scope.remote.traceStore.revertDecision({ ...request(workspaceId), decisionId }),
        confirm: (workspaceId, decisionId, revision) => scope.remote.traceStore.confirmDecision({ ...request(workspaceId), decisionId, revision }),
        reject: (workspaceId, decisionId, revision) => scope.remote.traceStore.rejectDecision({ ...request(workspaceId), decisionId, revision }),
        openSettings: () => { scope.settingsNavigation.openSection('panedesk-features') },
      }),
    }, TracePanel))
    scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
      name: 'conversation.session.header.actions', id: 'trace', order: 17, locale: 'trace',
      inject: (): TraceOpenActions => ({
        open: sessionId => { scope.sidebarRight.openResourceIn(sessionId, traceAddress(sessionId), { kind: 'trace' }) },
      }),
    }, TraceAction))
  })
  try { await ui } catch (error) { await ui.dispose(); throw error }
  return async () => { await ui.dispose() }
}
