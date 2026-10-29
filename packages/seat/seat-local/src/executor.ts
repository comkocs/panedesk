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
import type { LocalSeatOptions, LocalSeatRuntime } from './service-options.ts'
import { subscriptionFiles, registerSubscriptions } from './subscriptions.ts'
import { digest } from './store.ts'
import { LocalEngineState, localFact } from './engine-state.ts'
import { readSeatText, renderOpening } from './template.ts'
import { readLocalOpenInput } from './open-input.ts'
import { localSourceId } from './open-admission.ts'
import { observeOwner } from './owner-observation.ts'
import { recordOrphanedOpening } from './orphaned-opening.ts'
import { sessionCredentialSetup } from './session-credentials.ts'
import { readExecutionModel } from './model-evidence.ts'

/** Create an identity-preserving executor whose caller owns registration and disposal.
 * @param ctx - local plugin context.
 * @param runtime - public service adapter.
 * @param options - explicit opening and journal limits.
 * @returns executor for engine registration.
 */
export function createOpenExecutor(ctx: Context, runtime: LocalSeatRuntime, options: LocalSeatOptions): SeatOpenExecutor & {
  executionModel(sessionId: import('@panedesk/dsh-session').SessionId | null): Promise<import('@panedesk/dsh-seat').SeatExecutionModelEvidence>
} {
  const state = new LocalEngineState(() => ctx.get('seatEngine'), options.nodeId, options.pageSize, options.transactionRetries)
  const freeze = async (open: EngineOpenData): Promise<NonNullable<EngineOpenData['frozenOpening']>> => {
    if (open.frozenOpening) return open.frozenOpening
    const facts = (await state.read()).effects
    const previous = facts.find(effect => (effect.kind === 'open/intent' || effect.kind === 'open/configured')
      && effect.data.sessionId === open.sessionId && effect.data.frozenOpening !== undefined)
    if ((previous?.kind === 'open/intent' || previous?.kind === 'open/configured') && previous.data.frozenOpening) {
      return previous.data.frozenOpening
    }
    const def = definition(open)
    const source = open.sources?.find(item => item.sourceId === localSourceId)
    const opening = source ? readLocalOpenInput(source.data).opening
      : renderOpening(await readSeatText(def.opening, options.maxOpeningBytes),
        { seat: def.seat, date: new Date().toISOString().slice(0, 10),
          taskId: open.binding.kind === 'seat' ? open.binding.taskId ?? null : null }, options.maxOpeningBytes)
    return state.mutate((effects) => {
      const retained = effects.find(effect => (effect.kind === 'open/intent' || effect.kind === 'open/configured')
        && effect.data.sessionId === open.sessionId && effect.data.frozenOpening !== undefined)
      if ((retained?.kind === 'open/intent' || retained?.kind === 'open/configured') && retained.data.frozenOpening) {
        return { result: retained.data.frozenOpening, effects: [] }
      }
      return { result: opening, effects: [localFact({ kind: open.phase === 'intent' ? 'open/intent' : 'open/configured',
        sessionId: open.sessionId, data: { ...open, frozenOpening: opening } })] }
    })
  }
  const subscribed = new WeakSet<Agent>()
  const bindCredentials = sessionCredentialSetup(ctx)
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
      const def = definition(open)
      const handle = await agents.resume({ resumeSessionId: open.sessionId,
        agentOptions: { provider: def.provider, model: def.model,
          reasoningEffort: ReasoningEffortId(def.reasoningEffort) },
        setup: async (_agentCtx, agent) => {
          await bindCredentials(agent, open)
          // Completed permission stages retain their durable selection on resume.
          if (open.completedStages.includes('permission')) return
          const permissions = ctx.get('permissionPresets')
          if (permissions === undefined) throw new Error('Permission service is unavailable')
          permissions.set(agent.session, def.permissionPreset)
        } })
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
    executionModel: sessionId => readExecutionModel(ctx, sessionId, options.nodeId),
    observe: async (open) => {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return 'unknown'
      const saved = await persistence.stat(open.sessionId)
      if (saved === undefined) return 'absent'
      const startup = definition(open).directories.find(item => item.startup)
      return saved.header.cwd === startup?.path ? 'matching' : 'conflict'
    },
    create: async (open) => {
      await freeze(open)
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
          setup: async (_agentCtx, agent) => { await subscribe(agent, open); await bindCredentials(agent, open) } })
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
        const target = await workspace.create(startup.path)
        await target.attachSession(agent.id)
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
      const frozenOpening = await freeze(open)
      const delivery = ctx.get('messageDelivery')
      if (delivery === undefined) throw new Error('Message delivery is unavailable')
      const sent = open.openingMessageId === null ? await runtime.send({ sessionId: open.sessionId,
        operationId: open.openingOperationId, text: frozenOpening.text, mode: 'queue' }) : { messageId: open.openingMessageId }
      const status = await delivery.status(sent.messageId)
      if (status.state === 'injected') {
        const snapshot = await ctx.get('sessionQuery')?.readSession(open.sessionId)
        let turn: number | undefined, openingTurn: number | undefined
        for (const event of snapshot?.events ?? []) {
          if (event.type === 'turn/start') turn = event.data.turn
          if (event.type === 'user/message' && event.data.id === sent.messageId) openingTurn = turn
          if (event.type === 'turn/end' && openingTurn !== undefined && event.data.turn === openingTurn
            && event.data.reason.kind === 'error') return { messageId: sent.messageId, state: 'failed' }
        }
      }
      return { messageId: sent.messageId, state: status.state === 'responded' ? 'completed'
        : ['rejected', 'withdrawn', 'invalidated'].includes(status.state) ? 'failed' : 'pending' }
    },
    replacementFirstTurn: async (open) => {
      if (open.openingMessageId === null) return null
      const snapshot = await ctx.get('sessionQuery')?.readSession(open.sessionId)
      let turn: number | undefined, matched: number | undefined, hasAssistantReply = false
      for (const event of snapshot?.events ?? []) {
        if (event.type === 'turn/start') turn = event.data.turn
        if (event.type === 'user/message' && event.data.id === open.openingMessageId) matched = turn
        if (matched !== undefined && turn === matched && event.type === 'assistant/message') hasAssistantReply = true
        if (matched !== undefined && event.type === 'turn/end' && event.data.turn === matched) {
          return { messageId: open.openingMessageId, turnId: String(matched),
            completed: event.data.reason.kind === 'completed', hasAssistantReply }
        }
      }
      return null
    },
    notifyBudget: async (request) => { await runtime.send({ ...request,
      operationId: digest(request.operationId) as string as import('@panedesk/dsh-seat').SeatOperationId,
      text: JSON.stringify({ kind: 'budget-warning', budget: request.budget }) }) },
    wakeSender: async (request) => {
      const delivery = ctx.get('messageDelivery')
      if (delivery === undefined) return 'unavailable'
      const status = await delivery.status(request.messageId)
      if (!['queued', 'injected'].includes(status.state)) return 'cancelled'
      const result = await delivery.send({ target: { sessionId: request.senderSessionId }, content: `Message ${request.messageId} timed out.`,
        messageClass: 'handoff', priority: 'steer', operationId: String(request.wakeOperationId) as OperationId })
      return result.deliveryOutcome === 'accepted' ? 'sent' : 'unavailable'
    },
    owner: async (owner) => {
      const facts = (await state.read()).effects
      const latest = facts.findLast(effect => (effect.kind === 'open/intent' || effect.kind === 'open/created'
        || effect.kind === 'open/configured' || effect.kind === 'open/opening-failed') && effect.data.sessionId === owner.sessionId)
      if (latest && (latest.kind === 'open/intent' || latest.kind === 'open/created' || latest.kind === 'open/configured')
        && latest.data.phase !== 'active' && latest.data.phase !== 'opening-failed'
        && !latest.data.completedStages.includes('opening')) {
        // Resume interrupted creation, not an owner whose opening delivery was acknowledged.
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined || await persistence.stat(owner.sessionId) === undefined) return 'unknown'
        await agentFor(latest.data)
      }
      const observed = await observeOwner(ctx, owner, options.nodeId)
      if (observed === 'dead') await recordOrphanedOpening(ctx, state, owner.sessionId)
      return observed
    },
  }
}
