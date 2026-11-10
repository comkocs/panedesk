/** Opt-in project trace service: one Host-owned writer and same-transaction state/event updates. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Service } from '@panedesk/cordis'
import { Remote, TypertRemoteService, principalOf } from '@panedesk/dsh-typert-protocol'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import type { KvTable } from '@panedesk/dsh-storage-domain'
import type { Session, SessionId } from '@panedesk/dsh-session'
import type { WorkspaceId } from '@panedesk/dsh-workspace'
import type {} from '@panedesk/dsh-agent'
import type {} from '@panedesk/dsh-session-persistence'
import { openProjectDatabase, appendEvent, appendReference, mutationEvent, referenceColumns } from './database.ts'
import { registrySpec, disabledStatus } from './registry.ts'
import { installCapture } from './capture.ts'
import type { ProjectId, TraceStatus, WorkspaceRequest, TraceSource, TraceItem, ItemRequest, TimelineRequest, TimelinePage,
  TraceEvent, TraceReference, ReferenceId, ReferenceContent, DecisionId, DecisionRevision, DecisionWriteRequest, DecisionRevisionRequest } from './types.ts'
export type * from './types.ts'

declare module '@panedesk/cordis' { interface Context { traceStore: TraceStore } }

type SettingSource = (workspaceId: WorkspaceId) => string
const decisionColumns = 'decision_id AS id, revision, item_id AS itemId, title, body, status, source'

/** Project operations are available to every window after the workspace's one-time opt-in. */
export default class TraceStore extends TypertRemoteService {
  static inject = ['typert', 'storageDomain', 'workspaceRegistry', 'sessions', 'agents', 'sessionPersistence']
  private mappings!: KvTable<string, TraceStatus>
  private readonly databases = new Map<ProjectId, DatabaseSync>()
  private readonly settingSources = new Map<string, SettingSource>()
  private tail: Promise<void> = Promise.resolve()
  private readonly home = resolveDshHome()

  constructor(ctx: Context) { super(ctx, 'traceStore') }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(registrySpec)
    this.mappings = domain.table('workspaces')
    const drain = installCapture(this.ctx, this)
    this.ctx.effect(() => async () => {
      await drain()
      await this.tail
      for (const db of this.databases.values()) db.close()
      await domain.close()
    })
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private transaction<T>(db: DatabaseSync, operation: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private database(projectId: ProjectId): DatabaseSync {
    let db = this.databases.get(projectId)
    if (db === undefined) {
      db = openProjectDatabase(join(this.home, 'projects', projectId))
      this.databases.set(projectId, db)
    }
    return db
  }

  private path(workspaceId: WorkspaceId): string { return this.ctx.workspaceRegistry.get(workspaceId)!.path }
  private selected(request: WorkspaceRequest): { status: TraceStatus; db: DatabaseSync } {
    const status = this.status(request)
    if (!status.enabled || status.projectId === null) throw new Error('Trace recording is disabled / 事项记录未开启')
    return { status, db: this.database(status.projectId) }
  }

  private userOnly(): void {
    const principal = principalOf(this.ctx.invocation)
    if (this.ctx.agents.currentInitiator() !== undefined || (principal !== undefined && principal.kind !== 'owner')) {
      throw new Error('This operation requires the user / 此操作仅限用户')
    }
  }

  private source(request: WorkspaceRequest): TraceSource {
    const initiator = this.ctx.agents.currentInitiator()
    const session = initiator?.session ?? (request.sessionId === undefined ? undefined : this.ctx.sessions.get(request.sessionId))
    const status = this.status(request)
    return {
      actor: initiator === undefined ? 'user' : session?.header.origin === 'subagent' ? 'subagent'
        : session?.id === status.plannerSessionId ? 'planner' : 'executor',
      sessionId: session?.id ?? request.sessionId ?? null,
      model: initiator?.options.model ?? (session === undefined ? null : this.ctx.agents.get(session.id)?.options.model ?? null),
      time: Date.now(),
    }
  }

  /** Read workspace switches without opening an unselected project.
   * @param request Workspace selection.
   * @returns Saved switches, or disabled defaults.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  status(request: WorkspaceRequest): TraceStatus { return this.mappings.get(this.path(request.workspaceId)) ?? disabledStatus }

  /** Authorize recording once; an existing project identity is reused.
   * @param request Workspace and optional UI window.
   * @returns Committed switches.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  enable(request: WorkspaceRequest): Promise<TraceStatus> {
    this.userOnly()
    return this.enqueue(async () => {
      const prior = this.status(request)
      const status = { ...prior, enabled: true, projectId: prior.projectId ?? randomUUID() as ProjectId }
      const db = this.database(status.projectId)
      await this.mappings.put(this.path(request.workspaceId), status)
      this.migrateSettings(request.workspaceId, db)
      return status
    })
  }

  /** Stop new capture while retaining the database and stable mapping.
   * @param request Workspace selection.
   * @returns Committed disabled switches.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  disable(request: WorkspaceRequest): Promise<TraceStatus> {
    this.userOnly()
    return this.enqueue(async () => {
      const status = { ...this.status(request), enabled: false, strict: false, plannerSessionId: null }
      await this.mappings.put(this.path(request.workspaceId), status)
      return status
    })
  }

  /** Associate another workspace with an already registered project without scanning project directories.
   * @param request Workspace and known project identity.
   * @returns Committed mapping; association does not turn recording on.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  associateProject(request: WorkspaceRequest & { projectId: ProjectId }): Promise<TraceStatus> {
    this.userOnly()
    return this.enqueue(async () => {
      if (![...this.mappings.entries()].some(([, status]) => status.projectId === request.projectId)) {
        throw new Error('Unknown trace project / 未知事项项目')
      }
      const status = { ...this.status(request), projectId: request.projectId, strict: false, plannerSessionId: null }
      await this.mappings.put(this.path(request.workspaceId), status)
      if (status.enabled) this.migrateSettings(request.workspaceId, this.database(request.projectId))
      return status
    })
  }

  /** Strict mode requires recording and a designated non-subagent planning session.
   * @param request Workspace, strict switch, and planning session; null clears the planner when disabling.
   * @returns Committed switches.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  setStrict(request: WorkspaceRequest & { strict: boolean; plannerSessionId: SessionId | null }): Promise<TraceStatus> {
    this.userOnly()
    return this.enqueue(async () => {
      const prior = this.status(request)
      if (request.strict && (!prior.enabled || request.plannerSessionId === null)) throw new Error('Enable recording and select a planner / 请先开启记录并指定规划窗')
      if (request.strict) {
        const header = await this.header(request.plannerSessionId!)
        if (header.origin === 'subagent' || this.workspaceForHeader(header) !== request.workspaceId) throw new Error('Select a project planning window / 请选择本工作区规划窗')
      }
      const status = { ...prior, strict: request.strict, plannerSessionId: request.strict ? request.plannerSessionId : null }
      await this.mappings.put(this.path(request.workspaceId), status)
      return status
    })
  }

  /** Create an open item and its creation event atomically.
   * @param request Workspace and title.
   * @returns Created item with automatic attribution.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  createItem(request: WorkspaceRequest & { title: string }): Promise<TraceItem> {
    const source = this.source(request)
    return this.enqueue(() => {
      const { db } = this.selected(request)
      return this.transaction(db, () => {
        const result = db.prepare("INSERT INTO items(title,status,source) VALUES(?,'open',?)").run(request.title, JSON.stringify(source))
        const item = { id: Number(result.lastInsertRowid), title: request.title, status: 'open' as const, source }
        mutationEvent(db, 'item/created', item.id, source, JSON.stringify({ title: request.title }))
        return item
      })
    })
  }

  /** Close an item without deleting its history.
   * @param request Workspace and item number.
   * @returns Resolution after the status and event commit.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  closeItem(request: ItemRequest): Promise<void> { return this.setItemStatus(request, 'closed') }

  /** Void an item without deleting its history.
   * @param request Workspace and item number.
   * @returns Resolution after the status and event commit.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  voidItem(request: ItemRequest): Promise<void> { return this.setItemStatus(request, 'void') }

  private setItemStatus(request: ItemRequest, status: 'closed' | 'void'): Promise<void> {
    const source = this.source(request)
    return this.enqueue(() => {
      const { db } = this.selected(request)
      this.transaction(db, () => {
        db.prepare('UPDATE items SET status=? WHERE id=?').run(status, request.itemId)
        mutationEvent(db, `item/${status}`, request.itemId, source, '{}')
      })
    })
  }

  /** List items in creation order.
   * @param request Workspace selection.
   * @returns Project items including closed and void records.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  listItems(request: WorkspaceRequest): TraceItem[] {
    return (this.selected(request).db.prepare('SELECT * FROM items ORDER BY id').all() as { id: number; title: string; status: TraceItem['status']; source: string }[])
      .map(row => ({ ...row, source: JSON.parse(row.source) as TraceSource }))
  }

  /** Page a single item's timeline, or unassigned activity, by monotonic event number.
   * @param request Workspace, item filter, exclusive cursor (default zero), and page size (default 100).
   * @returns Ordered events, references, and continuation cursor.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  timeline(request: TimelineRequest): TimelinePage {
    const { db } = this.selected(request)
    const limit = request.limit ?? 100
    const rows = db.prepare(`SELECT id,item_id AS itemId,type,session_id AS sessionId,seq_start AS seqStart,seq_end AS seqEnd,
      json_object('actor',actor,'sessionId',operation_session,'model',model,'time',time) AS source,payload,dedup_key AS dedupKey
      FROM events WHERE item_id IS ? AND id > ? ORDER BY id LIMIT ?`).all(request.itemId, request.cursor ?? 0, limit + 1) as (Omit<TraceEvent, 'source'> & { source: string })[]
    const events = rows.slice(0, limit).map(row => ({ ...row, source: JSON.parse(row.source) as TraceSource }))
    const refs = events.flatMap(event => db.prepare(`SELECT ${referenceColumns} FROM refs WHERE event_id=?`).all(event.id) as TraceReference[])
    return { events, refs, nextCursor: rows.length > limit ? events.at(-1)!.id : null }
  }

  /** Assign only previously unassigned events; their references follow the event.
   * @param request Workspace, destination item, and exact event numbers.
   * @returns Resolution after assignment and audit event commit.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  assignEvents(request: ItemRequest & { eventIds: number[] }): Promise<void> {
    const source = this.source(request)
    return this.enqueue(() => {
      const { db } = this.selected(request)
      this.transaction(db, () => {
        for (const id of request.eventIds) db.prepare('UPDATE events SET item_id=? WHERE id=? AND item_id IS NULL').run(request.itemId, id)
        mutationEvent(db, 'events/assigned', request.itemId, source, JSON.stringify({ eventIds: request.eventIds }))
      })
    })
  }

  /** Append an item comment and its timeline fact atomically.
   * @param request Workspace, item, and comment text.
   * @returns Resolution after commit.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  comment(request: ItemRequest & { body: string }): Promise<void> {
    const source = this.source(request)
    return this.enqueue(() => {
      const { db } = this.selected(request)
      this.transaction(db, () => {
        const event = mutationEvent(db, 'comment/created', request.itemId, source, JSON.stringify({ body: request.body }))
        db.prepare('INSERT INTO comments(event_id,item_id,body) VALUES(?,?,?)').run(event, request.itemId, request.body)
      })
    })
  }

  /** Associate subsequent activity of this session and its descendants with an item.
   * @param request Workspace, item and target session.
   * @returns Resolution after association and audit fact commit.
   */
  @Remote({ resources: { workspace: request => request.workspaceId, session: request => request.targetSessionId } })
  linkSession(request: ItemRequest & { targetSessionId: SessionId }): Promise<void> {
    const source = this.source(request)
    return this.enqueue(async () => {
      const workspaceId = await this.workspaceForSession(request.targetSessionId)
      if (workspaceId === undefined || this.status({ workspaceId }).projectId !== this.status(request).projectId) throw new Error('Session belongs to another project / 会话不属于此项目')
      const { db } = this.selected(request)
      this.transaction(db, () => {
        db.prepare('INSERT INTO session_links VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET item_id=excluded.item_id').run(request.targetSessionId, request.itemId)
        mutationEvent(db, 'session/linked', request.itemId, source, JSON.stringify({ sessionId: request.targetSessionId }))
      })
    })
  }

  /** Write an active decision normally, or a planning-window proposal in strict mode.
   * @param request Workspace, optional decision id, item, title and body.
   * @returns Newly appended immutable revision.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  writeDecision(request: DecisionWriteRequest): Promise<DecisionRevision> {
    const source = this.source(request)
    return this.enqueue(() => {
      const { db, status } = this.selected(request)
      if (status.strict && (source.sessionId !== status.plannerSessionId || source.actor !== 'planner')) throw new Error('Only the planning window may propose decisions / 只有规划窗可以提议拍板')
      return this.transaction(db, () => {
        const id = request.decisionId ?? randomUUID() as DecisionId
        db.prepare('INSERT INTO decisions(id) VALUES(?) ON CONFLICT(id) DO NOTHING').run(id)
        return this.appendDecision(db, { id, itemId: request.itemId, title: request.title, body: request.body, source,
          status: status.strict ? 'proposed' : 'active' })
      })
    })
  }

  /** Confirm the exact outstanding proposal as a new active revision; only the user may confirm.
   * @param request Workspace, decision and proposed revision.
   * @returns New active revision.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  confirmDecision(request: DecisionRevisionRequest): Promise<DecisionRevision> {
    this.userOnly()
    return this.resolveProposal(request, 'active')
  }

  /** Reject the exact outstanding proposal without replacing the active decision.
   * @param request Workspace, decision and proposed revision.
   * @returns New rejection revision.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  rejectDecision(request: DecisionRevisionRequest): Promise<DecisionRevision> {
    this.userOnly()
    return this.resolveProposal(request, 'rejected')
  }

  private resolveProposal(request: DecisionRevisionRequest, status: 'active' | 'rejected'): Promise<DecisionRevision> {
    const source = this.source(request)
    return this.enqueue(() => {
      const { db } = this.selected(request)
      return this.transaction(db, () => {
        const latest = this.revisions(db, request.decisionId).at(-1)!
        if (latest.revision !== request.revision || latest.status !== 'proposed') throw new Error('Proposal is no longer pending / 提议已不再待确认')
        return this.appendDecision(db, { ...latest, source, status })
      })
    })
  }

  /** Restore the previous effective version as a new revision; in strict mode the user reverts directly and the planner proposes.
   * @param request Workspace and decision identity.
   * @returns Reversion revision, or a proposed reversion when the planner reverts in strict mode.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  revertDecision(request: WorkspaceRequest & { decisionId: DecisionId }): Promise<DecisionRevision> {
    const source = this.source(request)
    return this.enqueue(() => {
      const { db, status } = this.selected(request)
      const user = source.actor === 'user'
      if (status.strict && !user && (source.sessionId !== status.plannerSessionId || source.actor !== 'planner')) throw new Error('Only the planning window may propose decisions / 只有规划窗可以提议拍板')
      return this.transaction(db, () => {
        const active = db.prepare('SELECT active_revision AS revision FROM decisions WHERE id=?').get(request.decisionId) as { revision: number }
        const previous = this.revisions(db, request.decisionId).findLast(rev => rev.revision < active.revision && (rev.status === 'active' || rev.status === 'reverted'))
        if (previous === undefined) throw new Error('No previous effective revision / 没有上一版生效记录')
        return this.appendDecision(db, { ...previous, source, status: status.strict && !user ? 'proposed' : 'reverted' })
      })
    })
  }

  private appendDecision(db: DatabaseSync, input: Omit<DecisionRevision, 'revision'>): DecisionRevision {
    const { revision } = db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM decision_revs WHERE decision_id=?').get(input.id) as { revision: number }
    const record = { ...input, revision }
    db.prepare('INSERT INTO decision_revs VALUES(?,?,?,?,?,?,?)').run(input.id, revision, input.itemId, input.title, input.body, input.status, JSON.stringify(input.source))
    if (input.status === 'active' || input.status === 'reverted') db.prepare('UPDATE decisions SET active_revision=? WHERE id=?').run(revision, input.id)
    mutationEvent(db, `decision/${input.status}`, input.itemId, input.source, JSON.stringify({ decisionId: input.id, revision }))
    return record
  }

  private revisions(db: DatabaseSync, id: DecisionId): DecisionRevision[] {
    return (db.prepare(`SELECT ${decisionColumns} FROM decision_revs WHERE decision_id=? ORDER BY revision`).all(id) as (Omit<DecisionRevision, 'source'> & { source: string })[])
      .map(row => ({ ...row, source: JSON.parse(row.source) as TraceSource }))
  }

  /** Return only currently effective decisions, not pending or rejected proposals.
   * @param request Workspace selection.
   * @returns Current effective revisions.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  listDecisions(request: WorkspaceRequest): DecisionRevision[] {
    const { db } = this.selected(request)
    return (db.prepare('SELECT id,active_revision AS revision FROM decisions WHERE active_revision IS NOT NULL').all() as { id: DecisionId; revision: number }[])
      .map(row => this.revisions(db, row.id).find(rev => rev.revision === row.revision)!)
  }

  /** Read all revisions, including pending proposals and rejected versions.
   * @param request Workspace and optional decision identity; omission returns the entire project's history.
   * @returns Immutable revisions in decision/revision order.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  decisionHistory(request: WorkspaceRequest & { decisionId?: DecisionId }): DecisionRevision[] {
    const { db } = this.selected(request)
    const ids = request.decisionId === undefined ? (db.prepare('SELECT id FROM decisions ORDER BY id').all() as { id: DecisionId }[]).map(row => row.id) : [request.decisionId]
    return ids.flatMap(id => this.revisions(db, id))
  }

  /** Read a referenced session slice from SessionPersistence, or a durable diff file.
   * @param request Workspace and database-owned reference identity.
   * @returns Reference metadata and source JSON text; attachments return their declared path.
   */
  @Remote({ resources: { workspace: request => request.workspaceId } })
  async readReference(request: WorkspaceRequest & { referenceId: ReferenceId }): Promise<ReferenceContent> {
    const { db, status } = this.selected(request)
    const reference = db.prepare(`SELECT ${referenceColumns} FROM refs WHERE id=?`).get(request.referenceId) as TraceReference
    let text: string
    if (reference.kind === 'session-slice') {
      const handle = await this.ctx.sessionPersistence.open(reference.sessionId!, 'read')
      try { text = JSON.stringify((await handle.read(reference.seqStart!, reference.seqEnd! - reference.seqStart! + 1)).events) }
      finally { await handle.close() }
    } else if (reference.kind === 'change' && reference.diffFile !== null) {
      text = await readFile(join(this.home, 'projects', status.projectId!, 'diffs', reference.diffFile), 'utf8')
    } else text = reference.path ?? reference.summary
    return { reference, text }
  }

  /** Register the original settings source for migration on enable and after Host restart.
   * @param key Settings family owned by the caller, never exposed as a remote mutation.
   * @param read Read the original workspace value as JSON text.
   * @returns Disposer for the registration.
   */
  registerSettingSource(key: string, read: SettingSource): () => void {
    this.settingSources.set(key, read)
    void this.enqueue(() => {
      for (const workspace of this.ctx.workspaceRegistry.list()) {
        const status = this.status({ workspaceId: workspace.id })
        if (status.enabled && status.projectId !== null) this.migrateSettings(workspace.id, this.database(status.projectId))
      }
    }).catch(error => this.ctx.logger.warn('Trace setting migration failed / 事项设置迁移失败', error))
    return () => { this.settingSources.delete(key) }
  }

  private migrateSettings(workspaceId: WorkspaceId, db: DatabaseSync): void {
    for (const [key, read] of this.settingSources) {
      if (db.prepare('SELECT value FROM settings WHERE key=?').get(key) !== undefined) continue
      try { this.transaction(db, () => { db.prepare('INSERT INTO settings VALUES(?,?)').run(key, read(workspaceId)) }) }
      catch (error) { this.ctx.logger.warn('Trace setting migration failed; original storage remains active / 事项设置迁移失败，继续使用原存储', error) }
    }
  }

  /** Synchronous policy reads retain the existing tool-admission timing.
   * @param workspaceId Workspace selection.
   * @param key Registered settings family.
   * @returns Saved JSON text, or undefined when disabled or migration did not commit.
   */
  readSetting(workspaceId: WorkspaceId, key: string): string | undefined {
    const status = this.status({ workspaceId })
    if (!status.enabled || status.projectId === null) return undefined
    return (this.database(status.projectId).prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value
  }

  /** Replace a migrated setting; unmigrated/disabled workspaces stay on their original adapter.
   * @param workspaceId Workspace selection.
   * @param key Registered settings family.
   * @param value Validated JSON text from the owning adapter.
   * @returns True when committed to SQLite; false asks the adapter to use its original storage.
   */
  saveSetting(workspaceId: WorkspaceId, key: string, value: string): Promise<boolean> {
    this.userOnly()
    const source = this.source({ workspaceId })
    return this.enqueue(() => {
      if (this.readSetting(workspaceId, key) === undefined) return false
      const { db } = this.selected({ workspaceId })
      return this.transaction(db, () => {
        db.prepare('UPDATE settings SET value=? WHERE key=?').run(value, key)
        mutationEvent(db, 'settings/changed', null, source, JSON.stringify({ key }))
        return true
      })
    })
  }

  private async header(id: SessionId) {
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) return live.header
    const handle = await this.ctx.sessionPersistence.open(id, 'read')
    try { return handle.header } finally { await handle.close() }
  }

  private workspaceForHeader(header: Session['header']): WorkspaceId | undefined {
    const workspaces = this.ctx.workspaceRegistry.list()
    return (workspaces.find(workspace => workspace.sessionIds.includes(header.id))
      ?? workspaces.find(workspace => workspace.path === header.cwd))?.id
  }

  /** Resolve a session through its own workspace or its durable parent chain, without listing session storage.
   * @param id Session identity.
   * @returns Owning workspace when registered.
   */
  async workspaceForSession(id: SessionId): Promise<WorkspaceId | undefined> {
    const header = await this.header(id)
    return this.workspaceForHeader(header) ?? (header.parentSession === undefined ? undefined : this.workspaceForSession(header.parentSession))
  }

  /** Check capture eligibility synchronously, including a child whose parent owns the workspace.
   * @param session Live session.
   * @returns Whether the owning workspace has recording enabled.
   */
  recordsSession(session: Session): boolean {
    const workspaceId = this.workspaceForHeader(session.header)
    if (workspaceId !== undefined) return this.status({ workspaceId }).enabled
    const parent = session.header.parentSession === undefined ? undefined : this.ctx.sessions.get(session.header.parentSession)
    return parent === undefined ? false : this.recordsSession(parent)
  }

  /** Commit an observed fact and references through the same single writer used by manual operations.
   * @param sessionId Observed session identity.
   * @param fact Deterministic event metadata and optional sequence range.
   * @param references Metadata prepared before the transaction; diff files must already be durable.
   * @returns Resolution after commit or opt-out; duplicates do not create references.
   */
  async capture(sessionId: SessionId, fact: { type: string; key: string; payload: string; seqStart?: number; seqEnd?: number; time: number; observedSessionId?: SessionId; model?: string | undefined; actor?: TraceSource['actor'] | undefined }, references: Omit<TraceReference, 'id' | 'eventId'>[] = []): Promise<void> {
    const workspaceId = await this.workspaceForSession(sessionId)
    if (workspaceId === undefined || !this.status({ workspaceId }).enabled) return
    const ancestors: SessionId[] = fact.observedSessionId === undefined ? [] : [fact.observedSessionId]
    let id: SessionId | undefined = sessionId
    while (id !== undefined) { ancestors.push(id); id = (await this.header(id)).parentSession }
    const header = await this.header(sessionId)
    const source: TraceSource = { actor: fact.actor ?? (header.origin === 'subagent' ? 'subagent' : 'executor'),
      sessionId: fact.observedSessionId ?? sessionId,
      model: fact.model ?? this.ctx.agents.get(fact.observedSessionId ?? sessionId)?.options.model ?? null, time: fact.time }
    await this.enqueue(() => {
      if (!this.status({ workspaceId }).enabled) return
      const { db, status } = this.selected({ workspaceId })
      if (source.actor === 'executor' && status.plannerSessionId === sessionId) source.actor = 'planner'
      this.transaction(db, () => {
        const linked = ancestors.map(id => db.prepare('SELECT item_id AS id FROM session_links WHERE session_id=?').get(id) as { id: number } | undefined).find(row => row !== undefined)
        const eventId = appendEvent(db, { itemId: linked?.id ?? null, type: fact.type, sessionId: source.sessionId,
          seqStart: fact.seqStart ?? null, seqEnd: fact.seqEnd ?? null, source, payload: fact.payload, dedupKey: fact.key })
        if (eventId === null) return
        for (const reference of references) appendReference(db, { ...reference, eventId })
        db.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(sessionId, fact.key)
      })
    })
  }

  /** Locate durable diffs for an enabled live session; no other project is opened or scanned.
   * @param session Live session.
   * @returns Project diff directory, or undefined when recording is off.
   */
  async diffDirectory(session: Session): Promise<string | undefined> {
    const workspaceId = await this.workspaceForSession(session.id)
    if (workspaceId === undefined) return undefined
    const status = this.status({ workspaceId })
    return status.enabled ? join(this.home, 'projects', status.projectId!, 'diffs') : undefined
  }
}
