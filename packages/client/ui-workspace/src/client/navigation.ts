/** Workspace archive and directory UI capability. */

import type { NewSessionTimingId, SessionNewSessionTimingRequest } from '@panedesk/dsh-api-session-controller/types'
import { Service, type Context } from '@panedesk/cordis'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@panedesk/dsh-api-remotes/client'
import type {
  ISessions,
  SessionCreateError,
  SessionBinding,
  SessionReference,
  SessionTarget,
  SessionListState,
} from '@panedesk/dsh-api-session-controller/client'
// Type-only: pulls the `agentPreset` Session projection value into this program.
import type {} from '@panedesk/dsh-agent-preset-registry/types'
import { createSnapshotStore } from '@panedesk/dsh-client-store'
import type { SubagentAddress } from '@panedesk/dsh-subagent/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@panedesk/dsh-api-workspace-controller/client'
import type { SessionId } from '@panedesk/dsh-session/types'
import type {} from '@panedesk/dsh-client-ui-layout/client'
import type { DraftInitializationOptions } from '@panedesk/dsh-client-ui-conversation/client'
import type { RowToast } from './contract/slots.ts'
import { pinOrderAccounts, pinOrderSource } from './pin-order.ts'
import type { WorkspaceViewStoreActions } from './stores.ts'

type SessionConnectionOptions = Pick<StartSessionOptions, 'agentPreset'> & { readonly timingId?: NewSessionTimingId }
type NewSessionClickKind = NonNullable<SessionNewSessionTimingRequest['kind']>

interface MainSelection {
  readonly sessionId?: SessionId
  readonly subagentAddress?: SubagentAddress
}

/** Content preparation and Agent preset for the Session a Workspace flow opens. */
export interface StartSessionOptions extends DraftInitializationOptions {
  /** Agent preset the Session runs; the Host default when omitted. */
  readonly agentPreset?: string
}

/** Workspace archive and directory operations consumed by Client UI domains. */
export interface UiWorkspace {
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param target - known Session identity or durable direct-parent subagent address to display.
   */
  openSession(target: SessionTarget): void
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session,
   * skipped after supersession; a throw aborts the open and releases the retained reference.
   * @param options - choices for the Session the connection creates or reuses.
   * @returns completion; a superseded request may create a Session but does not open it.
   * @throws on failure; a refused creation is also shown through the Workspace
   * notice unless a later navigation or disposal superseded the request.
   */
  openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    options?: Pick<StartSessionOptions, 'agentPreset'>,
  ): Promise<void>
  /**
   * Fork a Session without changing the current selection.
   * @param sessionId - source Session.
   * @param onCreated - observer before the optional child-title update.
   * @param options - optional permission to start source migration; omission preserves the Host default.
   * @returns the child SessionId after creation and inherited-title increment.
   */
  forkSession(
    sessionId: SessionId,
    onCreated?: (childId: SessionId) => void,
    options?: Pick<Parameters<ISessions['fork']>[0], 'allowMigration'>,
  ): Promise<SessionId>
  /**
   * Resolve the Session for a new conversation in a Workspace: the Host reuses
   * the first listed blank member while it is reusable and otherwise creates one,
   * under the requested preset or the Host default.
   * @param workspaceId - target Workspace.
   * @param options - choices for the created or reused Session.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId, options?: Pick<StartSessionOptions, 'agentPreset'>): Promise<SessionId>
  /**
   * Reuse a blank Session or create one; repeated clicks join navigation but each records its timing. A creation the Host
   * refuses is shown through the Workspace notice and leaves the selection as it was.
   * @param workspaceId - explicit target; absent inherits the open Session's Workspace or, with none open, the most recent Workspace.
   * @param options - initial content and the reused blank's preset; existing text or attachments
   * are preserved unless clearPreviousDraft is true.
   */
  startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions): void
  /**
   * Archive a Session and clear it when it is the current selection.
   * @param sessionId - Session to archive.
   * @param options - `stopActivity` asks the Host to stop the Session's running work instead of refusing.
   */
  archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>
  /**
   * Unarchive a Session, restoring it to its recorded Workspace position.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
  /**
   * Pin a Session on the Host, then lead it in its accounts' saved orders
   * (its Workspace group or Ungrouped, and the flat list). The order write
   * reads the memberships current at completion, so reorders that landed
   * while the Host call was pending keep their positions.
   * @param sessionId - Session to pin.
   */
  pinSession(sessionId: SessionId): Promise<void>
  /**
   * Unpin a Session on the Host; saved positions stay as they are.
   * @param sessionId - Session to unpin.
   */
  unpinSession(sessionId: SessionId): Promise<void>
  /**
   * Open the Host-native directory picker.
   * @returns the selected directory, or null when cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one Host directory level.
   * @param path - directory path; absent selects the Host home.
   * @param signal - cancellation for a superseded scan.
   * @returns directory entries and breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create a child directory.
   * @param path - existing parent directory.
   * @param name - child directory name.
   * @returns created absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Cross-Controller Workspace navigation and directory UI capability. */
    uiWorkspace: UiWorkspace
  }
}

/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  /** @param rpcError - Host directory business failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  /** The latest in-flight connection per Workspace; a request joins it only when both name the same preset. */
  private readonly connecting = new Map<WorkspaceId, {
    readonly agentPreset: string | undefined
    readonly attempt: Promise<SessionId>
  }>()
  private readonly lifetime = new AbortController()
  private readonly selection = createSnapshotStore<MainSelection>(
    {}, { persist: { name: 'dsh.sessions.current' } },
  )
  private mainReference: SessionReference | undefined
  private opening: Promise<boolean> | undefined

  /**
   * @param ctx - Client root Context.
   * @param directoryPicker - the directory-picking Remote namespace.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   * @param view - the browser's viewing-store write set (one instance shared with its registration).
   * @param notify - show one notice through the Workspace notice channel.
   */
  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote['directoryPicker'],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
    private readonly view: Pick<WorkspaceViewStoreActions, 'pinSessionOrder'>,
    private readonly notify: (toast: RowToast) => void,
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => {
      const stop = this.watchNavigation()
      return () => {
        stop()
        this.lifetime.abort()
        const reference = this.mainReference
        this.mainReference = undefined
        reference?.release()
      }
    }, 'ui-workspace: Workspace navigation policy')
  }

  connectWorkspace(workspaceId: WorkspaceId, options: Pick<StartSessionOptions, 'agentPreset'> = {}): Promise<SessionId> {
    return this.connectBlank(workspaceId, options)
  }

  /**
   * @param reuse - preset for the reused or created blank.
   */
  private async connectBlank(
    workspaceId: WorkspaceId,
    reuse: SessionConnectionOptions,
  ): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined && inflight.agentPreset === reuse.agentPreset) return inflight.attempt

    const attempt = this.createInWorkspace(workspace, reuse).finally(() => {
      if (this.connecting.get(workspaceId)?.attempt === attempt) this.connecting.delete(workspaceId)
    })
    this.connecting.set(workspaceId, { agentPreset: reuse.agentPreset, attempt })
    return attempt
  }

  private createInWorkspace(workspace: WorkspaceView, options: SessionConnectionOptions): Promise<SessionId> {
    const blank = this.reusableBlank(workspace)
    return this.createNamed({
      workspaceId: workspace.workspaceId,
      ...(options.timingId === undefined ? {} : { timingId: options.timingId }),
      ...(blank === undefined ? {} : { sessionId: blank }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    })
  }

  /**
   * Create through the Host. A named blank the Host declined may still read as
   * blank from stale cached list metadata, which hides it from the Session tree;
   * its projections are reloaded so the row reflects its log.
   */
  private async createNamed(request: {
    readonly workspaceId: WorkspaceId
    readonly sessionId?: SessionId
    readonly agentPreset?: string
    readonly timingId?: NewSessionTimingId
  }): Promise<SessionId> {
    const sessionId = await this.sessions.create(request)
    const named = request.sessionId
    if (named !== undefined && named !== sessionId) {
      void this.sessions.refreshProjections(named).catch((reason: unknown) => {
        console.warn('declined blank Session projection reload failed:', reason)
      })
    }
    return sessionId
  }

  /**
   * Reopen a saved blank Session under the preset its log recorded, or under
   * the Host default once that preset no longer activates. Listed values are
   * cached hints that can lag the log after an unclean Host exit, so the
   * Session's projections are reloaded before the preset is read; a Session
   * that still awaits a format migration reloads only those cached hints.
   */
  private async restoreBlank(workspaceId: WorkspaceId, sessionId: SessionId): Promise<SessionId> {
    await this.sessions.refreshProjections(sessionId)
    const recorded = this.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset
    const request = { workspaceId, sessionId }
    if (typeof recorded !== 'string') return this.createNamed(request)
    try {
      return await this.createNamed({ ...request, agentPreset: recorded })
    } catch (error: unknown) {
      const code = sessionCreateErrorOf(error)?.rpcError.code
      if (code !== 'agent-preset/not-found' && code !== 'agent-preset/invalid') throw error
      return this.createNamed(request)
    }
  }

  openSession(target: SessionTarget): void {
    this.replaceMain(target, this.lifetime.signal, 'reveal')
  }

  async openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    options: SessionConnectionOptions = {},
  ): Promise<void> {
    await this.openWorkspaceSession(workspaceId, beforeOpen, options)
  }

  private async openWorkspaceSession(
    workspaceId: WorkspaceId,
    beforeOpen: ((sessionId: SessionId) => void) | undefined,
    reuse: SessionConnectionOptions,
  ): Promise<boolean> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    let sessionId: SessionId
    try {
      sessionId = await this.connectBlank(workspaceId, reuse)
    } catch (error: unknown) {
      // Reported here, not in connectWorkspace: startup restoration calls that
      // directly and stays console-only.
      if (!navigation.aborted) this.notify({ kind: 'createFailed', message: creationFailureMessage(error) })
      throw error
    }
    if (navigation.aborted) return false
    this.replaceMain(sessionId, navigation, 'reveal', beforeOpen)
    return !navigation.aborted
  }

  async forkSession(
    sessionId: SessionId,
    onCreated?: (childId: SessionId) => void,
    options?: Pick<Parameters<ISessions['fork']>[0], 'allowMigration'>,
  ): Promise<SessionId> {
    return this.sessions.fork({
      sessionId,
      increaseTitle: true,
      ...onCreated === undefined ? {} : { onCreated },
      ...options?.allowMigration === undefined ? {} : { allowMigration: options.allowMigration },
    })
  }

  startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions): void {
    const startedAt = performance.now()
    const timingId = crypto.randomUUID() as NewSessionTimingId
    if (this.opening !== undefined) {
      this.recordClick(timingId, startedAt, workspaceId, this.opening, 'reused')
      return
    }
    const { agentPreset, ...draft } = options ?? {}
    const draftOptions = options === undefined ? undefined : draft
    const initializeDraft = draftOptions !== undefined
      && (draftOptions.prompt !== undefined || draftOptions.clearPreviousDraft === true)
    const workspace = this.workspaces.list.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const current = this.mainReference?.sessionId
    // A subagent Session keeps its parent's directory, so its own id is absent
    // from every Workspace account; walk to the nearest ancestor that is a member.
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspaceOfSession(current, workspace.items, sessions.byId)
    const recent = workspace.phase === 'ready' && sessions.phase === 'ready'
      ? recentWorkspace(workspace.items, sessions.byId)
      : undefined
    const target = workspaceId ?? currentWorkspaceId ?? recent
    const kind = this.blankIn(target)
    if (target === undefined) {
      if (initializeDraft) {
        this.notify({ kind: 'createFailed', message: this.ctx.locale.bind('workspace')('draft.workspaceRequired') })
        this.recordClick(timingId, startedAt, target, Promise.resolve(false), kind)
        return
      }
      this.clearMain()
      this.recordClick(timingId, startedAt, target, Promise.resolve(true), kind)
      return
    }
    const opening = this.openWorkspaceSession(target, initializeDraft ? (id) => {
      const binding = this.sessions.binding(id)
      if (binding === undefined) this.draftPreparationFailed()
      this.prepareDraft(binding, draftOptions)
    } : undefined, { timingId, ...(agentPreset === undefined ? {} : { agentPreset }) })
    this.opening = opening
    this.recordClick(timingId, startedAt, target, opening, kind)
    void opening.catch(
      (reason: unknown) => { console.warn('new session failed:', reason) },
    ).finally(() => { this.opening = undefined })
  }

  /** Blank Session this click can reopen in the Workspace, when the list already shows one. */
  private reusableBlank(workspace: WorkspaceView): SessionId | undefined {
    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    return sessions.ids.find((id) => {
      const summary = sessions.byId[id]
      return summary !== undefined && summary.agentAvailable && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(id) && !archived.includes(id)
    })
  }

  /** Whether the selected Workspace already has a blank Session this click can reopen. */
  private blankIn(workspaceId: WorkspaceId | undefined): NewSessionClickKind {
    if (workspaceId === undefined) return 'created'
    const workspace = this.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    return workspace !== undefined && this.reusableBlank(workspace) !== undefined ? 'reused' : 'created'
  }

  /** Report after the selection has rendered and one frame has had a chance to paint. */
  private recordClick(
    timingId: NewSessionTimingId,
    startedAt: number,
    workspaceId: WorkspaceId | undefined,
    opening: Promise<boolean>,
    kind: NewSessionClickKind,
  ): void {
    const settled = (shown: boolean): void => {
      const reference = this.mainReference
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const pageShown = shown && reference === this.mainReference && !this.lifetime.signal.aborted
          const sessionId = pageShown ? reference?.sessionId : undefined
          void this.ctx.remote.session.recordNewSessionTiming({
            timingId,
            clientElapsedMs: Math.round(performance.now() - startedAt),
            pageShown,
            kind,
            ...(workspaceId === undefined ? {} : { workspaceId }),
            ...(sessionId === undefined ? {} : { sessionId }),
          }).then(result => {
            if (!result.ok) console.warn('new session timing failed:', result.error)
          }).catch((error: unknown) => { console.warn('new session timing failed:', error) })
        })
      })
    }
    void opening.then(settled, () => { settled(false) })
  }

  private prepareDraft(binding: SessionBinding, options: DraftInitializationOptions): void {
    const conversation = this.ctx.get('conversation')
    if (conversation === undefined) this.draftPreparationFailed()
    if (conversation.input.requestDraftInitialization(binding, options) === 'blocked') this.draftPreparationFailed()
  }

  private draftPreparationFailed(): never {
    const message = this.ctx.locale.bind('workspace')('draft.initializationFailed')
    this.notify({ kind: 'createFailed', message })
    throw new Error(message)
  }

  async archiveSession(sessionId: SessionId, options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    await this.workspaces.archiveSession(sessionId, options)
    if (this.mainReference?.sessionId === sessionId) this.clearMain()
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unarchiveSession(sessionId)
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.pinSession(sessionId)
    const { items, pinnedSessionIds, archivedSessionIds } = this.workspaces.list.getSnapshot()
    this.view.pinSessionOrder(
      sessionId,
      pinOrderAccounts(items, sessionId),
      pinOrderSource(items, this.sessions.list.getSnapshot(), { pinnedSessionIds, archivedSessionIds }),
    )
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unpinSession(sessionId)
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.directoryPicker.pick()
    if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
    return result.value
  }

  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const result = await this.directoryPicker.list(path, signal)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const result = await this.directoryPicker.createDirectory(path, name)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  private watchNavigation(): () => void {
    let initial: 'waiting' | 'connecting' | 'done' = 'waiting'
    const reconcile = (): void => {
      if (this.lifetime.signal.aborted) return
      if (this.clearArchivedCurrent()) return
      if (initial !== 'waiting') return
      const workspace = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
      if (this.mainReference !== undefined) {
        initial = 'done'
        return
      }
      initial = 'connecting'
      void this.restoreSelection(workspace, sessions).then(
        () => { initial = 'done' },
        (reason: unknown) => {
          if (this.lifetime.signal.aborted) return
          initial = 'waiting'
          console.warn('initial Session restoration failed:', reason)
        },
      )
    }

    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
    const disposeSessions = this.sessions.list.subscribe(reconcile)
    reconcile()
    return () => {
      this.lifetime.abort()
      disposeSessions()
      disposeWorkspaces()
    }
  }

  private async restoreSelection(workspaces: WorkspaceSnapshot, sessions: SessionListState): Promise<void> {
    const saved = this.selection.getSnapshot()
    if (saved.subagentAddress !== undefined) {
      this.replaceMain(saved.subagentAddress, this.lifetime.signal, 'preserve')
      return
    }
    const summary = saved.sessionId === undefined ? undefined : sessions.byId[saved.sessionId]
    const workspace = summary === undefined ? undefined
      : workspaces.items.find(item => item.sessionIds.includes(summary.id))
    if (summary !== undefined && (!summary.blank || workspace === undefined)) {
      this.replaceMain(summary.id, this.lifetime.signal, 'preserve')
      return
    }
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    let sessionId: SessionId | undefined
    if (summary !== undefined && workspace !== undefined && summary.cwd === workspace.path
      && !workspaces.archivedSessionIds.includes(summary.id)) {
      sessionId = await this.restoreBlank(workspace.workspaceId, summary.id)
    }
    let target = workspace?.workspaceId ?? recentWorkspace(workspaces.items, sessions.byId)
    if (target === undefined && workspaces.items.length === 0 && sessions.ids.length === 0) {
      const prepared = await this.initializeDefaultWorkspace(navigation)
      if (navigation.aborted) return
      target = prepared?.workspaceId
    }
    if (sessionId === undefined && target !== undefined) sessionId = await this.connectWorkspace(target)
    if (sessionId !== undefined && !navigation.aborted) {
      this.replaceMain(sessionId, navigation, 'preserve')
    }
  }

  private async initializeDefaultWorkspace(signal: AbortSignal): Promise<WorkspaceView | undefined> {
    try {
      return await this.workspaces.initializeDefault(signal)
    } catch (_error: unknown) {
      if (!signal.aborted) this.notify({ kind: 'defaultWorkspaceFailed' })
      return undefined
    }
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.mainReference?.sessionId
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.clearMain()
    return true
  }

  private clearMain(): void {
    const previous = this.mainReference
    this.mainReference = undefined
    this.selection.set({})
    previous?.release()
    this.ctx.layout.selectPanel(null)
  }

  private replaceMain(
    target: SessionTarget,
    signal: AbortSignal,
    panel: 'reveal' | 'preserve',
    beforeOpen?: (sessionId: SessionId) => void,
  ): void {
    signal.throwIfAborted()
    const reference = this.sessions.retain(target, { source: 'mainView' })
    try {
      signal.throwIfAborted()
      beforeOpen?.(reference.sessionId)
      if (signal.aborted) {
        reference.release()
        return
      }
      const subagentAddress = typeof target === 'string'
        ? this.sessions.subagentAddress(reference.sessionId)
        : target
      this.selection.set({
        sessionId: reference.sessionId,
        ...(subagentAddress === undefined ? {} : { subagentAddress }),
      })
    } catch (error: unknown) {
      reference.release()
      throw error
    }
    const previous = this.mainReference
    this.mainReference = reference
    previous?.release()
    if (panel === 'reveal') this.ctx.layout.selectPanel(null)
  }

}

/**
 * `error` as the Session Controller's creation failure, or undefined when it
 * is not one. Client plugin bundles do not share error-class identity, so the
 * name decides.
 */
function sessionCreateErrorOf(error: unknown): SessionCreateError | undefined {
  return error instanceof Error && error.name === 'SessionCreateError' ? error as SessionCreateError : undefined
}

/**
 * The words a failed Session creation is reported in: a Host refusal keeps its
 * stable code and message; any other failure keeps its own message.
 */
function creationFailureMessage(error: unknown): string {
  const refused = sessionCreateErrorOf(error)
  if (refused !== undefined) return `${refused.rpcError.code}: ${refused.rpcError.message}`
  return error instanceof Error ? error.message : String(error)
}

/**
 * The Workspace that accounts the Session, or the nearest ancestor that one
 * does. A subagent Session is absent from every Workspace account while its
 * parent stays a member of the directory both share.
 * @param sessionId - the open Session.
 * @param workspaces - current Workspace accounts.
 * @param sessions - current Session summaries, carrying parent links.
 * @returns the accounting Workspace, or undefined when no ancestor is a member.
 */
function workspaceOfSession(
  sessionId: SessionId,
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState['byId'],
): WorkspaceId | undefined {
  const seen = new Set<SessionId>()
  let current: SessionId | undefined = sessionId
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const owner = workspaces.find(item => item.sessionIds.includes(current as SessionId))
    if (owner !== undefined) return owner.workspaceId
    current = sessions[current]?.parentId
  }
  return undefined
}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

export { UiWorkspaceService }
