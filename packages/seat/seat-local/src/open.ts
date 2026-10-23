/** Opening stages retain one fixed session and release temporary ledger attribution on every outcome. */
import { randomUUID } from 'node:crypto'
import type { SessionId } from '@panedesk/dsh-session'
import type { Agent, AgentSetup, ModelSelection } from '@panedesk/dsh-agent'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import type { LedgerRunId, LedgerSessionContext, SessionLedger } from '@panedesk/dsh-session-ledger'
import type { EngineOpenData, OpenConfigurationStage, OpenSeatRequest, OpenSeatResult, SeatDefinition, SeatFailure, SeatRejected } from '@panedesk/dsh-seat'
import { readSeatText, renderOpening, type FrozenOpening } from './template.ts'

/** Engine-owned opening snapshot; none of these fields are editable conversation defaults. */
export interface LocalOpenIntent {
  data: EngineOpenData
  definition: SeatDefinition
  opening: FrozenOpening
  title: string
  openingMode: 'auto' | 'prefill'
}

/** Public controlled-create capability; no private controller instance is accepted. */
export interface ControlledSessionCreation {
  create(request: {
    readonly sessionId: SessionId
    readonly cwd: string
    readonly agentPreset?: string
    readonly setup?: AgentSetup
    readonly selection?: ModelSelection
    readonly releasePreparation?: () => void
  }): Promise<{ readonly agent: Pick<Agent, 'id'>; readonly agentPreset: string | undefined }>
}

/** The engine persists intent, stages, callbacks and admission; local orchestration executes upstream effects. */
export interface OpenRuntime {
  controller: ControlledSessionCreation
  ledger?: Pick<SessionLedger, 'bindContext'>
  now(): Date
  maxOpeningBytes: number
  resolve(request: OpenSeatRequest): Promise<SeatDefinition | OpenSeatResult>
  intent(request: OpenSeatRequest, definition: SeatDefinition,
    opening: () => Promise<FrozenOpening>): Promise<LocalOpenIntent | OpenSeatResult>
  exists(sessionId: SessionId): Promise<boolean>
  restore(sessionId: SessionId): Promise<void>
  created(intent: LocalOpenIntent): Promise<void>
  configure(stage: Exclude<OpenConfigurationStage, 'opening'>, intent: LocalOpenIntent): Promise<void>
  configured(stage: OpenConfigurationStage, intent: LocalOpenIntent): Promise<void>
  releaseAdmission(intent: LocalOpenIntent): Promise<void>
  sendOpening(intent: LocalOpenIntent): Promise<void>
  result(intent: LocalOpenIntent): Promise<OpenSeatResult>
  failed(intent: LocalOpenIntent, failure: SeatFailure): Promise<SeatRejected>
}

/** Resolve and freeze before creating; replay obtains the engine's original opening snapshot.
 * @param runtime - public upstream capabilities and durable engine coordination.
 * @param request - authenticated and node-checked operation.
 * @returns opening outcome; failures preserve any already-created window.
 */
export async function openSeat(runtime: OpenRuntime, request: OpenSeatRequest): Promise<OpenSeatResult> {
  const definition = await runtime.resolve(request)
  if ('status' in definition) return definition
  const intent = await runtime.intent(request, definition, async () => renderOpening(
    await readSeatText(definition.opening, runtime.maxOpeningBytes),
    { seat: definition.seat, date: runtime.now().toISOString().slice(0, 10), taskId: request.taskId ?? null }, runtime.maxOpeningBytes))
  if ('status' in intent) return intent
  let created = intent.data.phase !== 'intent' && intent.data.phase !== 'creating'
  let unbind: (() => void) | undefined
  const releasePreparation = () => { const release = unbind; unbind = undefined; release?.() }
  try {
    const binding = intent.data.binding
    if (binding.kind !== 'seat') throw new Error('Controlled opening requires a seat binding')
    const context: LedgerSessionContext = { sessionId: intent.data.sessionId, rootSessionId: intent.data.sessionId,
      runId: randomUUID() as LedgerRunId, nodeId: binding.nodeId, seat: binding.seat, window: intent.title,
      identitySource: binding.identitySource, accountLabel: 'unknown', ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }) }
    unbind = runtime.ledger?.bindContext(context)
    if (await runtime.exists(intent.data.sessionId)) await runtime.restore(intent.data.sessionId)
    else {
      if (created) throw new Error('A previously created window cannot be recreated')
      const startup = intent.definition.directories.find(directory => directory.startup)
      if (startup === undefined) throw new Error('Opening snapshot has no startup directory')
      const actual = await runtime.controller.create({ sessionId: intent.data.sessionId, cwd: startup.path,
        agentPreset: intent.definition.agentPreset, releasePreparation, selection: { provider: intent.definition.provider,
          model: intent.definition.model, reasoningEffort: ReasoningEffortId(intent.definition.reasoningEffort) } })
      if (actual.agent.id !== intent.data.sessionId) throw new Error('Controlled creation changed the reserved session identity')
    }
    // Publication includes beginAgentRun ownership; its disposer does not release our temporary owner.
    releasePreparation()
    if (!created) { await runtime.created(intent); created = true }
    for (const stage of ['workspace', 'model', 'permission', 'subscriptions', 'title', 'binding'] as const) {
      if (intent.data.completedStages.includes(stage)) continue
      await runtime.configure(stage, intent)
      await runtime.configured(stage, intent)
    }
    await runtime.releaseAdmission(intent)
    if (intent.openingMode === 'auto' && !intent.data.completedStages.includes('opening')) {
      await runtime.sendOpening(intent)
      await runtime.configured('opening', intent)
    }
    return await runtime.result(intent)
  } catch (error) {
    const failure: SeatFailure = { code: created ? 'open-configuration-failed' : 'open-create-failed',
      message: error instanceof Error ? error.message : 'Opening failed.', alternative: 'Inspect the retained opening operation before retrying.',
      retryable: false, effectState: created ? 'partial' : 'unknown' }
    return await runtime.failed(intent, failure)
  } finally { releasePreparation() }
}
