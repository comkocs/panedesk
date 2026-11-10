/** Display-only activity accounting over the existing durable call journal. */
import { randomUUID } from 'node:crypto'
import { Context, Service, type Volatile } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import { brandString, type Branded } from '@panedesk/dsh-brand'
import type { Session, SessionId } from '@panedesk/dsh-session'
import { includeDescendantSessions, type LedgerEvent, type LedgerSnapshot, type LedgerRunId, type LedgerEventId } from '@panedesk/dsh-session-ledger'
import type {} from '@panedesk/dsh-agent'
import type {} from '@panedesk/dsh-tools'
import type {} from '@panedesk/dsh-llm'
import type {} from '@panedesk/dsh-subagent'
import type {} from '@panedesk/dsh-working-directory'
import type {} from '@panedesk/dsh-workspace'
import type {} from '@panedesk/dsh-settings'
import { ACTIVITY_CATEGORIES, type ActivityCategory } from './categories.ts'
import { classifyActivity, type ActivityClassification, type ActivityRule } from './classify.ts'
import type { ActivitySummary, ActivityTotal } from './types.ts'
export { ACTIVITY_CATEGORIES, ACTIVITY_REFUSAL } from './categories.ts'
export { classifyActivity, ACTIVITY_RULES } from './classify.ts'
export type { ActivityCategory } from './categories.ts'
export type { ActivityRule, ActivitySession, ActivityClassification } from './classify.ts'
export type * from './types.ts'

/** Path-keyed workspace rules, persisted in the active product profile, not project files. */
export interface Config { projects: Volatile<Record<string, ActivityRule[]>> }

interface Task {
  id: Branded<'ActivityTaskId'>
  startedAt: number
  created: Set<string>
  ancestorTaskIds?: readonly string[]
}
type Start = Extract<LedgerEvent, { kind: 'activity/start' }>
type End = Extract<LedgerEvent, { kind: 'activity/end' }>

/** Fold the latest observed task without counting the script tag twice.
 * @param snapshot Existing ledger snapshot.
 * @param sessionId Session whose own task is requested.
 * @param now Observation time used only for operations still live in this process.
 * @param live Activity ids currently executing; unmatched historical starts do not keep ticking.
 * @returns Latest task summary, or null without observed operations.
 */
export function activitySummary(snapshot: LedgerSnapshot, sessionId: SessionId, now: number, live: ReadonlySet<string> = new Set()): ActivitySummary | null {
  const starts: Start[] = []
  const ends = new Map<string, End>()
  for (const row of snapshot.rows) {
    if (row.kind !== 'event' || row.event.sessionId !== sessionId) continue
    if (row.event.kind === 'activity/start') starts.push(row.event)
    if (row.event.kind === 'activity/end') ends.set(row.event.activityId, row.event)
  }
  starts.sort((a, b) => a.startedAt - b.startedAt)
  const latest = starts.at(-1)
  if (latest === undefined) return null
  const totals = new Map<ActivityCategory, ActivityTotal>()
  let totalMs = 0
  let verificationMs = 0
  let current: ActivitySummary['current'] = null
  for (const start of starts) {
    if (start.taskId !== latest.taskId || !(start.category in ACTIVITY_CATEGORIES)) continue
    const category = start.category as ActivityCategory
    const end = ends.get(start.activityId)
    const active = live.has(start.activityId)
    const durationMs = end?.durationMs ?? (active ? Math.max(0, now - start.startedAt) : 0)
    totalMs += durationMs
    if (start.selfWrittenScript || ['build', 'test-focused', 'test-full', 'mutation', 'client', 'ci', 'script'].includes(category)) verificationMs += durationMs
    for (const tag of [category, ...(start.selfWrittenScript && category !== 'script' ? ['script' as const] : [])]) {
      const row = totals.get(tag) ?? { category: tag, count: 0, durationMs: 0, share: 0 }
      row.count++
      row.durationMs += durationMs
      totals.set(tag, row)
    }
    if (current === null || active || !current.active) current = { category, selfWrittenScript: start.selfWrittenScript, startedAt: start.startedAt, durationMs, active }
  }
  return { taskId: latest.taskId, startedAt: latest.taskStartedAt, totalMs, verificationMs, current,
    totals: [...totals.values()].map(row => ({ ...row, share: totalMs === 0 ? 0 : row.durationMs / totalMs })) }
}

declare module '@panedesk/cordis' { interface Context { activityCategory: ActivityCategoryService } }

/** Task classification and timing service. It never returns policy decisions or cancels execution. */
export default class ActivityCategoryService extends Service {
  static inject = ['tools', 'llm', 'agents', 'sessions', 'sessionLedger', 'workingDirectory']
  static Config = Schema.object({
    projects: Schema.dict(Schema.array(Schema.object({ contains: Schema.string().default(''),
      category: Schema.union(Object.keys(ACTIVITY_CATEGORIES)).default('other') }))).default({}).volatile(),
  })
  private readonly tasks = new Map<SessionId, Task>()
  private readonly runs = new Map<SessionId, string>()
  private readonly parents = new Map<SessionId, { id: SessionId; task: Task }>()
  private readonly live = new Set<string>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'activityCategory')
    ctx.inject(['settings'], scope => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message' && event.data.source.kind === 'user' && !this.runs.has(session.id)
        && ctx.sessionLedger.contextFor(session.id)?.subagentRunId === undefined) {
        this.tasks.set(session.id, { id: brandString<Branded<'ActivityTaskId'>>(`user:${session.id}:${event.seq}`), startedAt: event.time, created: new Set() })
      }
    })
    ctx.on('subagent/start', info => {
      if (!info.local) return
      this.runs.set(info.id, info.runId)
      this.tasks.set(info.id, { id: brandString<Branded<'ActivityTaskId'>>(info.runId), startedAt: Date.now(), created: new Set() })
      const context = ctx.sessionLedger.contextFor(info.id)
      const parent = context?.parentSessionId === undefined ? undefined : ctx.sessions.get(context.parentSessionId)
      if (parent !== undefined) {
        const task = this.task(parent)
        this.parents.set(info.id, { id: parent.id, task })
        this.tasks.get(info.id)!.ancestorTaskIds = [task.id, ...task.ancestorTaskIds ?? []]
      }
    })
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.agent === undefined) return next()
      const session = exec.agent.session
      const args = exec.arguments as Record<string, unknown>
      let classification: ActivityClassification
      let finish: (created: string[]) => Promise<void>
      try {
        classification = await this.classify(exec.name, args, session)
        finish = await this.begin(session, classification)
      } catch (error) {
        ctx.logger.warn('Activity accounting unavailable; tool execution is unchanged', error)
        return next()
      }
      let created: string[] = []
      try {
        const result = await next()
        const meta = result.meta
        if (!result.isError && classification.category === 'write' && meta !== null && typeof meta === 'object' && !Array.isArray(meta)
          && meta['operation'] === 'create' && typeof meta['path'] === 'string') created = [meta['path']]
        return result
      } finally {
        try { await finish(created) }
        catch (error) { ctx.logger.warn('Activity duration was not saved; tool result is unchanged', error) }
      }
    })
    const service = this
    ctx.on('llm/stream', async function* (request, next) {
      const agent = request.sessionId === undefined ? ctx.agents.currentInitiator() : ctx.agents.get(request.sessionId)
      if (agent === undefined) { yield* next(); return }
      let finish: (created: string[]) => Promise<void>
      try { finish = await service.begin(agent.session, { category: 'model', selfWrittenScript: false }) }
      catch (error) {
        ctx.logger.warn('Activity accounting unavailable; model execution is unchanged', error)
        yield* next()
        return
      }
      try { yield* next() } finally {
        try { await finish([]) }
        catch (error) { ctx.logger.warn('Activity duration was not saved; model result is unchanged', error) }
      }
    })
  }

  private task(session: Session): Task {
    const existing = this.tasks.get(session.id)
    if (existing !== undefined) return existing
    const run = this.ctx.sessionLedger.contextFor(session.id)?.subagentRunId
    // Initial materialization only; later requests update the task from committed events.
    const messages = session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const last = messages.at(-1)
    const task: Task = { id: brandString<Branded<'ActivityTaskId'>>(run ?? `user:${session.id}:${last?.seq ?? session.seq}`), startedAt: last?.time ?? Date.now(), created: new Set() }
    this.tasks.set(session.id, task)
    return task
  }

  /** Classify using this task's confirmed new files, including descendant writes.
   * @param toolName Runtime tool name, including nested PTC calls.
   * @param args Parsed tool arguments.
   * @param session Calling session.
   * @returns Primary category and independent script tag.
   */
  async classify(toolName: string, args: Readonly<Record<string, unknown>>, session: Session): Promise<ActivityClassification> {
    const task = this.task(session)
    const cwd = this.ctx.workingDirectory.get(session)
    const workspaces = this.ctx.get('workspaceRegistry')?.list() ?? []
    const workspace = workspaces.find(item => item.sessionIds.includes(session.id))
      ?? workspaces.filter(item => cwd === item.path || cwd.startsWith(`${item.path}/`) || cwd.startsWith(`${item.path}\\`)).sort((a, b) => b.path.length - a.path.length)[0]
    if (typeof args['command'] === 'string') {
      const snapshot = await this.ctx.sessionLedger.snapshot()
      const descendants = new Set<SessionId>([session.id])
      includeDescendantSessions(snapshot.rows, descendants)
      const owned = new Set(snapshot.rows.flatMap(row => row.kind === 'event' && row.event.kind === 'activity/start'
        && descendants.has(row.event.sessionId) && (row.event.taskId === task.id || row.event.ancestorTaskIds.includes(task.id)) ? [row.event.activityId] : []))
      for (const row of snapshot.rows) if (row.kind === 'event' && row.event.kind === 'activity/end' && owned.has(row.event.activityId)) {
        for (const path of row.event.createdFiles) task.created.add(path)
      }
    }
    return classifyActivity(toolName, args, { cwd, createdFiles: [...task.created], rules: this.config.projects.get()[workspace?.path ?? cwd] ?? [] })
  }

  /** Query durable totals for a session's latest task, retaining them after completion.
   * @param sessionId Calling session identity.
   * @param snapshot Optional already-authorized tree ledger snapshot to avoid a second scan.
   * @returns Category counts, milliseconds, shares and latest activity, or null without evidence.
   */
  async read(sessionId: SessionId, snapshot?: LedgerSnapshot): Promise<ActivitySummary | null> {
    const summary = activitySummary(snapshot ?? await this.ctx.sessionLedger.snapshot({ sessionId }), sessionId, Date.now(), this.live)
    const task = this.tasks.get(sessionId)
    return task !== undefined && summary?.taskId !== task.id
      ? { taskId: task.id, startedAt: task.startedAt, totals: [], totalMs: 0, verificationMs: 0, current: null }
      : summary
  }

  /** Identify this task and its captured root turn, including child runs started during an older turn.
   * @param session Calling session.
   * @returns Current task id and owning root-turn id.
   */
  taskIdentity(session: Session): { taskId: string; rootTaskId: string } {
    const task = this.task(session)
    return { taskId: task.id, rootTaskId: task.ancestorTaskIds?.at(-1) ?? task.id }
  }

  /** Read all operations attributed to this root turn, including every descendant task.
   * @param session Calling root or descendant session.
   * @returns Root-turn totals with overlapping script time counted once.
   */
  async readRootTurn(session: Session): Promise<ActivitySummary | null> {
    const { rootTaskId } = this.taskIdentity(session)
    const snapshot = await this.ctx.sessionLedger.snapshot()
    const owned = new Set(snapshot.rows.flatMap(row => row.kind === 'event' && row.event.kind === 'activity/start'
      && (row.event.taskId === rootTaskId || row.event.ancestorTaskIds.includes(rootTaskId)) ? [row.event.activityId] : []))
    const rows: LedgerSnapshot['rows'] = snapshot.rows.flatMap(row => {
      if (row.kind !== 'event' || (row.event.kind !== 'activity/start' && row.event.kind !== 'activity/end') || !owned.has(row.event.activityId)) return []
      return [{ ...row, event: { ...row.event, sessionId: session.id, taskId: brandString<Branded<'ActivityTaskId'>>(rootTaskId) } }]
    })
    return activitySummary({ ...snapshot, rows }, session.id, Date.now(), this.live)
  }

  private async begin(session: Session, classification: ActivityClassification): Promise<(created: string[]) => Promise<void>> {
    const task = this.task(session)
    const activityId = brandString<Branded<'ActivityId'>>(randomUUID())
    const context = this.ctx.sessionLedger.contextFor(session.id)
    const nodeId = context?.nodeId ?? await this.ctx.sessionLedger.nodeId()
    const runId = context?.runId ?? brandString<LedgerRunId>(task.id)
    const ancestorTaskIds = task.ancestorTaskIds ?? []
    const startedAt = Date.now()
    const envelope = { schemaVersion: 1 as const, nodeId, runId, sessionId: session.id }
    const append = async (event: LedgerEvent): Promise<void> => {
      const result = await this.ctx.sessionLedger.appendEvent(event)
      if (result.kind === 'conflict') throw new Error('Activity journal append conflicted')
    }
    await append({ ...envelope, eventId: brandString<LedgerEventId>(randomUUID()), observedAt: startedAt,
      kind: 'activity/start', activityId, taskId: task.id, taskStartedAt: task.startedAt, ancestorTaskIds, startedAt, ...classification })
    this.live.add(activityId)
    const started = performance.now()
    return async created => {
      const durationMs = performance.now() - started
      this.live.delete(activityId)
      await append({ ...envelope, eventId: brandString<LedgerEventId>(randomUUID()), observedAt: Date.now(),
        kind: 'activity/end', activityId, taskId: task.id, durationMs, createdFiles: created })
      for (const path of created) task.created.add(path)
      let parent = this.parents.get(session.id)
      while (parent !== undefined && this.tasks.get(parent.id) === parent.task) {
        for (const path of created) parent.task.created.add(path)
        parent = this.parents.get(parent.id)
      }
    }
  }
}
