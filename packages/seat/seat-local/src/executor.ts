/** Public Session effects only; the engine retains identity allocation and resource transactions. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import type { LedgerRunId } from '@panedesk/dsh-session-ledger'
import type { EngineOpenData, SeatOpenExecutor } from '@panedesk/dsh-seat'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import type {} from '@panedesk/dsh-api-session-controller'
import type {} from '@panedesk/dsh-session-persistence'
import type {} from '@panedesk/dsh-instruction-subscriptions'
import type { LocalSeatRuntime } from './service-options.ts'
import { subscriptionFiles, registerSubscriptions } from './subscriptions.ts'

/** Create an identity-preserving executor whose caller owns registration and disposal.
 * @param ctx - local plugin context.
 * @param runtime - public service adapter.
 * @returns executor for engine registration.
 */
export function createOpenExecutor(ctx: Context, runtime: LocalSeatRuntime): SeatOpenExecutor {
  const subscribed = new WeakSet<Agent>()
  const definition = (open: EngineOpenData) => {
    if (open.definition === undefined || open.binding.kind !== 'seat') throw new Error('Opening definition is unavailable')
    return open.definition
  }
  const agentFor = async (open: EngineOpenData): Promise<Agent> => {
    const agents = ctx.get('agents')
    if (agents === undefined) throw new Error('Agent service is unavailable')
    const live = agents.get(open.sessionId)
    if (live !== undefined) return live
    const ledger = ctx.get('sessionLedger')
    const binding = open.binding
    if (ledger === undefined || binding.kind !== 'seat') throw new Error('Resume ledger identity is unavailable')
    const release = ledger.bindContext({ sessionId: open.sessionId, rootSessionId: open.sessionId,
      runId: randomUUID() as LedgerRunId, nodeId: binding.nodeId, seat: binding.seat, window: open.title ?? binding.seat,
      identitySource: binding.identitySource, accountLabel: 'unknown', ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }) })
    try {
      const handle = await agents.resume({ resumeSessionId: open.sessionId })
      ctx.effect(() => () => handle.dispose())
      return handle.agent
    } finally { release() }
  }
  const subscribe = async (agent: Agent, open: EngineOpenData) => {
    if (subscribed.has(agent)) return
    const files = await subscriptionFiles(definition(open), [])
    const dispose = await registerSubscriptions(ctx.get('instructionSubscriptions'), agent, files)
    agent.ctx.effect(() => dispose)
    ctx.effect(() => dispose)
    subscribed.add(agent)
  }
  return {
    observe: async (open) => {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return 'unknown'
      const saved = await persistence.stat(open.sessionId)
      if (saved === undefined) return 'absent'
      const startup = definition(open).directories.find(item => item.startup)
      return saved.header.cwd === startup?.path ? 'matching' : 'conflict'
    },
    create: async (open) => {
      const def = definition(open)
      const creation = ctx.get('sessionCreation')
      const ledger = ctx.get('sessionLedger')
      const binding = open.binding
      if (creation === undefined || ledger === undefined || binding.kind !== 'seat') throw new Error('Controlled creation is unavailable')
      const startup = def.directories.find(item => item.startup)
      if (startup === undefined) throw new Error('Startup directory is unavailable')
      let release: (() => void) | undefined = ledger.bindContext({ sessionId: open.sessionId, rootSessionId: open.sessionId,
        runId: randomUUID() as LedgerRunId, nodeId: binding.nodeId, seat: binding.seat, window: open.title ?? binding.seat,
        identitySource: binding.identitySource, accountLabel: 'unknown', ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }) })
      const releasePreparation = () => { const dispose = release; release = undefined; dispose?.() }
      try {
        const result = await creation.create({ sessionId: open.sessionId, cwd: startup.path,
          agentPreset: def.agentPreset, selection: { provider: def.provider, model: def.model,
            reasoningEffort: ReasoningEffortId(def.reasoningEffort) }, releasePreparation,
          setup: async (_agentCtx, agent) => { await subscribe(agent, open) } })
        if (result.agent.id !== open.sessionId) throw new Error('Controlled creation changed the session identity')
        await ctx.get('sessions')?.flush(result.agent.session)
        return result.agent.id
      } finally { releasePreparation() }
    },
    configure: async (open, stage) => {
      const agent = await agentFor(open)
      const def = definition(open)
      if (stage === 'workspace') {
        const startup = def.directories.find(item => item.startup)
        const workspace = ctx.get('workspaceRegistry')
        if (workspace === undefined || startup === undefined || agent.session.header.cwd !== startup.path) {
          throw new Error('Workspace placement does not match the opening intent')
        }
        await workspace.create(startup.path)
      } else if (stage === 'model') {
        const controller = ctx.get('sessionController')
        if (controller === undefined) throw new Error('Session model selection is unavailable')
        await controller.selectModel({ sessionId: agent.id, provider: def.provider,
          model: def.model, reasoningEffort: def.reasoningEffort })
      } else if (stage === 'permission') {
        const permissions = ctx.get('permissionPresets')
        if (permissions === undefined) throw new Error('Permission service is unavailable')
        permissions.set(agent.session, def.permissionPreset)
      } else if (stage === 'subscriptions') await subscribe(agent, open)
      else if (stage === 'title') {
        const titles = ctx.get('sessionTitle')
        if (titles === undefined || open.title === undefined) throw new Error('Window title is unavailable')
        titles.rename(agent.session, open.title)
      }
      await ctx.get('sessions')?.flush(agent.session)
    },
    opening: async (open) => {
      if (open.openingMode === 'prefill') throw new Error('Prefill must settle without invoking the opening executor')
      if (open.frozenOpening === undefined) throw new Error('Frozen opening text is unavailable')
      const delivery = ctx.get('messageDelivery')
      if (delivery === undefined) throw new Error('Message delivery is unavailable')
      const sent = open.openingMessageId === null ? await runtime.send({ sessionId: open.sessionId,
        operationId: open.openingOperationId, text: open.frozenOpening.text, mode: 'queue' }) : { messageId: open.openingMessageId }
      const status = await delivery.status(sent.messageId)
      return { messageId: sent.messageId, state: status.state === 'responded' ? 'completed'
        : ['rejected', 'withdrawn', 'invalidated'].includes(status.state) ? 'failed' : 'pending' }
    },
    notifyBudget: async (request) => { await runtime.send({ ...request, text: 'Budget limit is approaching.' }) },
    wakeSender: async (request) => {
      const delivery = ctx.get('messageDelivery')
      if (delivery === undefined) return 'unavailable'
      const status = await delivery.status(request.messageId)
      if (!['queued', 'injected'].includes(status.state)) return 'cancelled'
      const result = await delivery.send({ target: { sessionId: request.senderSessionId }, content: `Message ${request.messageId} timed out.`,
        messageClass: 'handoff', priority: 'steer', operationId: String(request.wakeOperationId) as OperationId })
      return result.deliveryOutcome === 'accepted' ? 'sent' : 'unavailable'
    },
    owner: owner => Promise.resolve(ctx.get('agents')?.get(owner.sessionId) === undefined ? 'unknown' : 'alive'),
  }
}
