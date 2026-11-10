/** Workspace verification decisions shared by native tools and nested programmatic calls. */
import { Context, Service } from '@panedesk/cordis'
import { Remote, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import { ACTIVITY_CATEGORIES, ACTIVITY_REFUSAL, type ActivityCategory } from '@panedesk/dsh-activity-category'
import { deadline, timeoutOf } from '@panedesk/dsh-timeout'
import type { Session } from '@panedesk/dsh-session'
import type { ToolExecution, ToolExecutionToken, PreToolDecision } from '@panedesk/dsh-tools'
import type {} from '@panedesk/dsh-agent'
import type {} from '@panedesk/dsh-system-prompt'
import type {} from '@panedesk/dsh-working-directory'
import type {} from '@panedesk/dsh-workspace'
import type {} from '@panedesk/dsh-session-ledger'
import { openVerificationStorage, presets } from './storage.ts'
import type { VerificationSettings, VerificationView, VerificationWorkspaceRequest, VerificationSaveRequest, VerificationTaskRequest, VerificationTaskRestrictions } from './types.ts'
export type * from './types.ts'

declare module '@panedesk/cordis' { interface Context { verificationPolicy: VerificationPolicy } }
const testCategories: readonly ActivityCategory[] = ['test-focused', 'test-full', 'mutation', 'script']
const verificationCategories: readonly ActivityCategory[] = ['build', ...testCategories, 'client', 'ci']
const timeoutCode = 'VERIFICATION_CLIENT_TIMEOUT'

/** Policy is not registered with model-editable settings; remote writes use owner authentication. */
export default class VerificationPolicy extends TypertRemoteService {
  static inject = ['typert', 'tools', 'activityCategory', 'storageDomain', 'workspaceRegistry', 'workingDirectory', 'systemPrompt', 'sessionLedger', 'sessions']
  private storage!: Awaited<ReturnType<typeof openVerificationStorage>>
  private readonly prohibited = new Map<string, Set<ActivityCategory>>()
  private readonly stopped = new Set<string>()
  private readonly fullTurns = new Map<string, { used: boolean; pending: Set<ToolExecutionToken> }>()
  private readonly reservations = new Map<ToolExecutionToken, string>()

  constructor(ctx: Context) {
    super(ctx, 'verificationPolicy')
  }

  protected async [Service.init](): Promise<void> {
    this.storage = await openVerificationStorage(this.ctx)
    this.ctx.on('tools/pre-execute', (exec, next) => this.decide(exec, next))
    this.ctx.on('tools/result', exec => {
      const root = this.reservations.get(exec.token)
      if (root !== undefined) this.fullTurns.get(root)?.pending.delete(exec.token)
      this.reservations.delete(exec.token)
    })
    this.ctx.on('tools/execute', async (exec, next) => {
      const root = this.reservations.get(exec.token)
      if (root !== undefined) {
        const turn = this.fullTurns.get(root)!
        turn.used = true
        turn.pending.delete(exec.token)
        this.reservations.delete(exec.token)
      }
      if (exec.agent === undefined) return next()
      const settings = this.forSession(exec.agent.session)
      if (!settings.enabled || settings.clientMinutes === null) return next()
      const classified = await this.ctx.activityCategory.classify(exec.name, exec.arguments as Record<string, unknown>, exec.agent.session)
      if (classified.category !== 'client') return next()
      const timeoutMs = settings.clientMinutes * 60_000
      using timer = deadline(exec.signal, timeoutMs, timeoutCode)
      const upstream = exec.signal
      exec.signal = timer.signal
      try {
        const result = await next()
        if (timeoutOf(timer.signal, timeoutCode) === undefined) return result
        const message = `Client launch exceeded ${settings.clientMinutes} minutes; its process was terminated. / 启动客户端超过 ${settings.clientMinutes} 分钟，进程已终止。`
        return { content: [{ type: 'text' as const, text: message }], isError: true as const,
          error: { message, info: { name: 'VerificationTimeoutError', code: timeoutCode } } }
      } finally { exec.signal = upstream }
    })
    this.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      if (context.agent !== undefined) {
        const settings = this.forSession(context.agent.session)
        assembly.sections.push({ name: 'verification-policy', interpolate: false,
          text: `Verification policy (read-only; enforced before tools): ${JSON.stringify(settings)}` })
      }
      return assembly
    })
  }

  private forSession(session: Session): VerificationSettings {
    const rootId = this.ctx.sessionLedger.contextFor(session.id)?.rootSessionId ?? session.id
    const cwd = this.ctx.workingDirectory.get(session)
    const workspaces = this.ctx.workspaceRegistry.list()
    const workspace = workspaces.find(item => item.sessionIds.includes(session.id) || item.sessionIds.includes(rootId))
      ?? workspaces.filter(item => cwd === item.path || cwd.startsWith(`${item.path}/`) || cwd.startsWith(`${item.path}\\`)).sort((a, b) => b.path.length - a.path.length)[0]
    return workspace === undefined ? presets.default : this.storage.read(workspace.id)
  }

  private refusal(category: ActivityCategory, once = false): PreToolDecision {
    const en = ACTIVITY_REFUSAL.en.replace('<category>', ACTIVITY_CATEGORIES[category].en)
    const zh = ACTIVITY_REFUSAL.zh.replace('〈类〉', ACTIVITY_CATEGORIES[category].zh)
    return { kind: 'deny', reason: `${once ? 'Full test run already used once this turn. 本轮全量已用过一次。 ' : ''}${en} / ${zh}` }
  }

  private async decide(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    if (exec.agent === undefined) return next()
    const session = exec.agent.session
    const settings = this.forSession(session)
    if (!settings.enabled) return next()
    const classified = await this.ctx.activityCategory.classify(exec.name, exec.arguments as Record<string, unknown>, session)
    const { taskId, rootTaskId } = this.ctx.activityCategory.taskIdentity(session)
    const tags = [classified.category, ...(classified.selfWrittenScript ? ['script' as const] : [])]
    const switches: Partial<Record<ActivityCategory, boolean>> = {
      'test-full': settings.fullTests !== 'deny', mutation: settings.mutation, script: settings.scripts,
      ci: settings.ci, 'test-focused': settings.focusedTests,
    }
    const denied = tags.find(category => switches[category] === false || this.prohibited.get(taskId)?.has(category)
      || (this.stopped.has(taskId) && testCategories.includes(category)))
    if (denied !== undefined) return this.refusal(denied)
    const downstream = await next()
    if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
    let decision = downstream
    if (tags.some(category => verificationCategories.includes(category))) {
      const totals = await this.ctx.activityCategory.read(session.id)
      const elapsed = totals?.verificationMs ?? 0
      const exceeded = (settings.budget.minutes !== null && elapsed > settings.budget.minutes * 60_000)
        || (settings.budget.percent !== null && (totals?.totalMs ?? 0) > 0 && elapsed / totals!.totalMs * 100 > settings.budget.percent)
      if (exceeded) {
        if (settings.budget.action === 'deny') return this.refusal(classified.category)
        const en = 'Verification time budget exceeded. Choose: allow this once / allow verification for this task / stop verification for this task. This approval supports allow once or reject; task-wide choices are unavailable in this approval dialog.'
        const zh = '验证用时已超预算。选项：放行这一次 / 本任务都放行 / 本任务停掉验证。现有审批仅支持单次放行或拒绝，当前审批框尚不支持任务级选项。'
        decision = { kind: 'ask', reason: en, displayReason: { en, zh } }
      }
    }
    if (classified.category === 'test-full' && settings.fullTests === 'once') {
      const totals = await this.ctx.activityCategory.readRootTurn(session)
      const turn = this.fullTurns.get(rootTaskId) ?? { used: false, pending: new Set<ToolExecutionToken>() }
      this.fullTurns.set(rootTaskId, turn)
      if (turn.used || turn.pending.size > 0 || (totals?.totals.find(row => row.category === 'test-full')?.count ?? 0) > 0) return this.refusal('test-full', true)
      // Reserve synchronously after the ledger read so sibling agents cannot both pass an empty snapshot.
      turn.pending.add(exec.token)
      this.reservations.set(exec.token, rootTaskId)
    }
    return decision
  }

  /** Append checklist prohibitions for an exact task without changing workspace settings.
   * @param request Task identity and shared category ids; takes effect on its next tool call.
   */
  addTaskProhibitions(request: VerificationTaskRestrictions): void {
    const session = this.ctx.sessions.get(request.sessionId)!
    if (this.ctx.activityCategory.taskIdentity(session).taskId !== request.taskId) return
    const categories = this.prohibited.get(request.taskId) ?? new Set<ActivityCategory>()
    for (const category of request.categories) categories.add(category)
    this.prohibited.set(request.taskId, categories)
  }

  /** Read the exact task's tree-checkbox state.
   * @param taskId Activity task identity.
   * @returns Whether subsequent tests and self-written scripts are prohibited by the row control.
   */
  testsStopped(taskId: string): boolean { return this.stopped.has(taskId) }

  /** Read current workspace switches for settings and checklist grey-out decisions.
   * @param request Selected workspace identity.
   * @returns Versioned saved switches and the three product presets.
   */
  @Remote
  readWorkspace(request: VerificationWorkspaceRequest): VerificationView {
    return { settings: this.storage.read(request.workspaceId), presets }
  }

  /** Replace workspace switches without writing project files or model settings.
   * @param request Workspace identity and complete settings.
   * @returns Persisted settings and presets.
   */
  @Remote
  async saveWorkspace(request: VerificationSaveRequest): Promise<VerificationView> {
    await this.storage.save(request.workspaceId, request.settings)
    return this.readWorkspace(request)
  }

  /** Toggle the running tree row without stopping its current process.
   * @param request Exact task identity and checkbox state.
   */
  @Remote
  setTestsStopped(request: VerificationTaskRequest): void {
    const session = this.ctx.sessions.get(request.sessionId)!
    if (this.ctx.activityCategory.taskIdentity(session).taskId !== request.taskId) return
    if (request.prohibited) this.stopped.add(request.taskId)
    else this.stopped.delete(request.taskId)
  }
}
