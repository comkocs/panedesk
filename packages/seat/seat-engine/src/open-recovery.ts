/** Recovery never creates a second identity or repeats an uncertain model turn. */
import type { EngineOpenData, SeatOpenExecutor, EngineEffect, SeatCallbackDelivery } from '@panedesk/dsh-seat'
import { EngineJournal, EngineError } from './journal.ts'
import { fact } from './triggers.ts'

const configurationStages = ['workspace', 'model', 'permission', 'subscriptions', 'title', 'binding'] as const

/** Identify durable recovery that can only query an already sent opening message.
 * @param open - Persisted opening checkpoint, including completed configuration stages.
 * @returns Whether recovery needs neither creation, configuration nor a first send.
 */
export function isOpeningObservation(open: EngineOpenData): boolean {
  return open.phase === 'opening-pending' && open.openingMessageId !== null && open.openingMode !== 'prefill'
    && configurationStages.every(stage => open.completedStages.includes(stage))
}

/** Resume one original intent through idempotent executor stages.
 * @param journal - exclusive node writer.
 * @param initial - fixed durable intent.
 * @param executor - local provider with persistence observation and never-mint creation.
 * @param createdCallbacks - callback facts committed with the first created observation.
 * @param beforeEffect - Optional supervisor checkpoint; false retains the last durable phase without another external effect.
 * @returns latest committed phase; uncertain first turns remain pending.
 */
export async function reconcileOpen(journal: EngineJournal, initial: EngineOpenData, executor: SeatOpenExecutor,
  createdCallbacks: (open: EngineOpenData) => readonly SeatCallbackDelivery[] | Promise<readonly SeatCallbackDelivery[]>,
  beforeEffect?: () => Promise<boolean>,
): Promise<EngineOpenData> {
  let current = journal.projection.opens.get(initial.sessionId) ?? initial
  if (current.phase === 'active' || current.phase === 'opening-failed') return current
  const publish = async (kind: 'open/created' | 'open/configured', updated: EngineOpenData, extra: readonly EngineEffect[] = []) => {
    await journal.commit((view) => {
      const latest = view.opens.get(updated.sessionId)
      const budget = view.budgets.get(updated.sessionId) ?? updated.budget
      current = { ...updated, budget,
        ...(latest?.frozenOpening ? { frozenOpening: latest.frozenOpening } : {}),
        ...(latest?.openingMode ? { openingMode: latest.openingMode } : {}) }
      return [fact({ kind, sessionId: current.sessionId,
        ...(current.binding.kind === 'seat' ? { seat: current.binding.seat } : {}), data: current }), ...extra]
    })
  }
  if (current.phase === 'intent' || current.phase === 'creating') {
    if (beforeEffect && !await beforeEffect()) return current
    const observed = await executor.observe(current)
    if (observed === 'conflict') throw new EngineError('session-id-conflict', 'Reserved Session identity belongs to another operation')
    if (observed === 'unknown') throw new EngineError('owner-unknown', 'Session persistence ownership is unknown')
    if (observed === 'absent') {
      const id = await executor.create(current)
      if (id !== current.sessionId) throw new EngineError('session-id-conflict', 'Executor returned a different Session identity; opening is blocked')
    }
    const created: EngineOpenData = { ...current, phase: 'created' }
    await publish('open/created', created, (await createdCallbacks(created))
      .map(data => fact({ kind: 'callback/pending', sessionId: created.sessionId, data })))
  }
  for (const stage of configurationStages) {
    if (current.completedStages.includes(stage)) continue
    if (beforeEffect && !await beforeEffect()) return current
    await executor.configure(current, stage)
    await publish('open/configured', { ...current, phase: 'configuring', completedStages: [...current.completedStages, stage] })
  }
  if (current.openingMode === 'prefill') {
    await publish('open/configured', { ...current, phase: 'active' })
    return current
  }
  if (current.phase !== 'opening-pending') await publish('open/configured', { ...current, phase: 'opening-pending' })
  if (beforeEffect && !await beforeEffect()) return current
  const opening = await executor.opening(current)
  if (opening.state === 'failed') {
    const failed: EngineOpenData = { ...current, openingMessageId: opening.messageId, phase: 'opening-failed', failure: {
      code: 'opening-failed', message: 'The original opening turn failed.', alternative: 'Inspect the existing Session before retrying.', retryable: false, effectState: 'partial' } }
    await journal.commit(() => [fact({ kind: 'open/opening-failed', sessionId: failed.sessionId, data: failed })])
    return failed
  }
  await publish('open/configured', { ...current, openingMessageId: opening.messageId,
    phase: opening.state === 'completed' ? 'active' : 'opening-pending', completedStages: [...new Set([...current.completedStages, 'opening' as const])] })
  return current
}
