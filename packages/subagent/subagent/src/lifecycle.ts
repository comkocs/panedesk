/**
 * Lifecycle-edge publication for managed subagent activations.
 *
 * Public event payloads live in `./types.ts`; the package-private observer
 * retains only the identity shared by each start/end pair.
 *
 * @module @panedesk/dsh-subagent/lifecycle
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import { foldConsumedWork } from '@panedesk/dsh-agent'
import type { SessionEvent, SessionId } from '@panedesk/dsh-session'
import { SubagentRunId } from './types.ts'
import type { SubagentResult, SubagentRunEndInfo, SubagentRunInfo, SubagentStartRequest } from './types.ts'
import { brandString } from '@panedesk/dsh-brand'
import type { LedgerAppendResult, LedgerContext, LedgerEvent, LedgerEventId, LedgerRunId, LedgerRunStart, SessionLedger } from '@panedesk/dsh-session-ledger'
import type { PresetExecutionPolicy } from '@panedesk/dsh-agent-preset-registry'
import { checkDeliveries, prepareDeliveries, sanitizeDiagnostic, writeErrorArtifacts, type DeliveryPlan } from './delivery.ts'
import { SubagentError } from './error.ts'
import type { Scoped } from '@panedesk/dsh-scope'
import type SubagentRuntime from './index.ts'

/**
 * Lifecycle observer for one activation's residency epoch. Package-private: the
 * continuation manager is the only consumer, and its call ordering is an
 * in-package contract rather than a published extension point.
 */
export interface ActivationObserver {
  /**
   * Publish the start edge once the epoch is resident.
   * @param child - the resident local Agent, or undefined for an external execution.
   */
  start(child?: Agent): void
  /** Await launch admission before local execution is created. */
  prepare?(request: SubagentStartRequest, policy?: PresetExecutionPolicy): Promise<void>
  /** Queue a synchronous policy refusal for durable settlement. */
  deny?(operation: 'model' | 'effort' | 'tool', requested: string, policy: PresetExecutionPolicy, reason: string): void
  /** Await terminal accounting independently of the contained emit notifications. */
  complete?(result: SubagentResult): Promise<SubagentResult>
  /**
   * Publish the terminal edge exactly once, pairing this epoch's {@link start},
   * after the disposal outcome is known. Called only for a resident epoch: a
   * failure before residency publishes no edge, because inventing one would
   * report a lifecycle the child never had.
   * @param result - the captured result, with teardown failures applied.
   */
  settle(result: SubagentResult): void
}

/**
 * Publish one lifecycle edge with per-listener exception containment. Run edges
 * carry the delegating parent that keys scoped dispatch; provider removal has no
 * parent carrier and reaches listeners unscoped.
 *
 * The service owns this closure because scoped dispatch keys its carrier by the
 * exact service instance, whose own context filter composes into the carrier;
 * a narrowed stand-in would silently change scope filtering.
 */
export type LifecycleEmitter = {
  (name: 'subagent/start', info: SubagentRunInfo, parent: Agent): void
  (name: 'subagent/end', info: SubagentRunEndInfo, parent: Agent): void
  (name: 'subagent/provider-removed', info: string): void
}

/**
 * Build the contained lifecycle emitter this seam publishes every edge through.
 * Every listener is independently contained: a synchronous throw or a rejected
 * returned promise is logged without starving peer listeners, changing the run,
 * or — for provider removal, which fires from a disposer — breaking teardown.
 * @param ctx - the service's own context, owning dispatch and the logger.
 * @param carrier - resolve the scoped dispatch carrier for one delegating parent.
 * @returns the emitter both observers and the provider registry publish through.
 */
export function createLifecycleEmitter(
  ctx: Context,
  carrier: (parent: Agent) => object,
): LifecycleEmitter {
  return (
    name: 'subagent/start' | 'subagent/end' | 'subagent/provider-removed',
    info: SubagentRunInfo | SubagentRunEndInfo | string,
    parent?: Agent,
  ): void => {
    const dispatchArgs: unknown[] = parent === undefined
      ? [name, info]
      : [carrier(parent), name, info]
    for (const callback of ctx.events.dispatch('emit', dispatchArgs)) {
      try {
        const returned: unknown = callback(info)
        void Promise.resolve(returned).catch((error: unknown) => {
          ctx.logger.warn(`subagent: ${name} listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        ctx.logger.warn(`subagent: ${name} listener threw: ${renderThrown(error)}`)
      }
    }
  }
}

/**
 * Build the observer for one local or external activation's residency epoch. Creation failure before residency emits no lifecycle edge.
 * @param emit - the contained lifecycle emitter.
 * @param provider - the provider name recorded in the durable descriptor.
 * @param childId - the durable child session id.
 * @param parent - the exact live direct parent keying scoped dispatch.
 * @param boundary - optional runtime services and scoped carrier for durable accounting.
 * @returns the observer whose edges this epoch publishes.
 */
export function createActivationObserver(
  emit: LifecycleEmitter,
  provider: string,
  childId: SessionId,
  parent: Agent,
  boundary?: { ctx: Context; carrier: Scoped<SubagentRuntime> },
): ActivationObserver {
  const external = boundary?.ctx.get('sessionLedger') !== undefined
    && boundary.ctx.get('subagents')?.getProvider(provider)?.prepareContinuable === undefined
  const identity = { runId: SubagentRunId(external ? childId : randomUUID()), provider, id: childId, local: false }
  let ledger: SessionLedger | undefined
  let context: LedgerContext | undefined
  let parentRunId: LedgerRunId | undefined
  let plan: DeliveryPlan | undefined
  let begun = false
  let completed = false
  const writes: Promise<void>[] = []
  const runId = brandString<LedgerRunId>(identity.runId)
  const append = async (fact: Extract<LedgerEvent, { kind: 'policy/denied' | 'delivery' }>): Promise<void> => {
    if (ledger !== undefined) assertLedgerWrite(await ledger.appendEvent(fact))
  }
  const envelope = () => {
    if (context === undefined) throw new SubagentError('Subagent ledger context is unavailable', 'LEDGER_UNAVAILABLE')
    return { schemaVersion: 1 as const, eventId: brandString<LedgerEventId>(randomUUID()),
      nodeId: context.nodeId, observedAt: Date.now(), runId, sessionId: childId }
  }
  return {
    prepare: async (request, policy) => {
      if (boundary === undefined) return
      identity.local = true
      plan = await prepareDeliveries(boundary.ctx, parent, request.deliveryPaths)
      ledger = boundary.ctx.get('sessionLedger')
      if (ledger !== undefined) {
        const snapshot = await ledger.snapshot({ sessionId: parent.id })
        const row = snapshot.rows.findLast(row => row.kind !== 'event' && row.start.sessionId === parent.id)
        const source = ledger.contextFor(parent.id) ?? (snapshot.complete && row?.kind !== 'event' ? row?.start : undefined)
        if (source === undefined) throw new SubagentError('Parent ledger identity is unavailable; child execution refused', 'LEDGER_UNAVAILABLE')
        parentRunId = source.runId
        context = { seat: source.seat, window: source.window,
          ...source.taskId === undefined ? {} : { taskId: source.taskId },
          nodeId: source.nodeId, rootSessionId: source.rootSessionId, accountLabel: source.accountLabel,
          sessionId: childId, parentSessionId: parent.id, subagentRunId: identity.runId, identitySource: 'inherited' }
      }
      await boundary.ctx.serial(boundary.carrier, 'subagent/before-start', { parent, info: { ...identity }, request })
      if (ledger !== undefined && context !== undefined) {
        const start: LedgerRunStart = { ...context, runId, ...parentRunId === undefined ? {} : { parentRunId }, startedAt: Date.now(), launchState: 'started',
          deliveryPaths: plan?.paths ?? [],
          ...policy === undefined ? {} : (await import('@panedesk/dsh-agent-preset-registry')).executionPolicyMetadata(policy),
          ...request.agentPreset === undefined ? {} : { definition: request.agentPreset },
          ...request.agentOptions?.model === undefined ? {} : { effectiveModel: request.agentOptions.model },
          processIdentity: { nodeId: context.nodeId, pid: process.pid, registeredAt: Date.now(), verification: 'unverified' } }
        assertLedgerWrite(await ledger.beginRun(start))
        begun = true
      }
    },
    deny: (operation, requested, policy, reason) => {
      if (ledger === undefined) return
      const write = append({ ...envelope(), kind: 'policy/denied', operation, requested: sanitizeDiagnostic(requested),
        definition: `${policy.rulesId}@${policy.version}`, reason: sanitizeDiagnostic(reason) })
      // Preserve rejection for complete(), while observing it immediately to avoid detached failures.
      void write.catch(() => undefined)
      writes.push(write)
    },
    complete: async (result) => {
      if (boundary === undefined || !identity.local || completed) return result
      completed = true
      const failures: unknown[] = []
      const pending = await Promise.allSettled(writes)
      for (const write of pending) if (write.status === 'rejected') failures.push(write.reason)
      const delivery = await checkDeliveries(plan)
      let artifacts: string[] = []
      if (plan !== undefined && result.stopReason === 'error' && result.diagnostic !== undefined) {
        try { artifacts = await writeErrorArtifacts(plan, identity.runId, result.diagnostic) }
        catch (error) { failures.push(error) }
      }
      if (ledger !== undefined && begun) {
        try {
          for (const file of delivery.files) {
            const errorArtifact = artifacts.find(path => path.startsWith(`${file.path}.err`))
            assertLedgerWrite(await ledger.appendEvent({ ...envelope(), kind: 'delivery',
              paths: [file.path], state: file.state, ...errorArtifact === undefined ? {} : { errorArtifact } }))
          }
          if (failures.length === 0) assertLedgerWrite(await ledger.finishRun({ runId, endedAt: Date.now(), observedAt: Date.now(),
            endReason: result.stopReason === 'completed' ? 'completed' : result.stopReason === 'aborted' ? 'cancelled'
              : (result.stopReason as string) === 'timeout' ? 'timeout' : (result.stopReason as string) === 'killed' ? 'killed' : 'error',
            upstreamStopReason: result.stopReason, recovered: false, deliveryState: delivery.state,
            ...artifacts[0] === undefined ? {} : { errorArtifact: artifacts[0] } }))
        } catch (error) { failures.push(error) }
      }
      try { await boundary.ctx.serial(boundary.carrier, 'subagent/after-settle', {
        parent, info: { ...identity, stopReason: result.stopReason,
          ...result.output.length === 0 ? {} : { lastAssistantMessage: result.output } }, result,
      }) } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'Subagent terminal accounting failed; outcome is not durably confirmed')
      return plan === undefined ? result : { ...result, deliveryState: delivery.state }
    },
    start: (child?: Agent): void => {
      identity.local = child !== undefined
      emit('subagent/start', identity, parent)
    },
    settle: ({ stopReason, output }: SubagentResult): void => {
      emit('subagent/end', {
        ...identity,
        stopReason,
        ...output.length === 0 ? {} : { lastAssistantMessage: output },
      }, parent)
    },
  }
}

/**
 * Why this child's epoch ended, for the terminal lifecycle edge and the
 * manager's own parent delivery. The child's own log is authoritative:
 * teardown succeeding says nothing about whether the model errored, hit its
 * token ceiling, or was cancelled, so deriving the reason from disposal would
 * report failed work as completed.
 *
 * {@link foldConsumedWork} supplies both halves the raw turn sequence cannot:
 * which turn accounts for the work this epoch consumed, and whether accepted
 * work was cancelled after it without any turn opening over it. A recorded
 * failure still wins over a cancellation — stopping a child that had already
 * failed does not turn its failure into a cancellation.
 * @param events - this epoch's own event suffix.
 * @returns its terminal stop reason; `completed` only for an epoch that both
 *   closed cleanly and had nothing left to run.
 */
export function epochStopReason(events: readonly SessionEvent[]): SubagentResult['stopReason'] {
  const { end, droppedUnrun } = foldConsumedWork(events)
  switch (end?.data.reason.kind) {
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'error':
      return 'error'
    // A pre-step rejection — a hook deny, a policy plugin — discarded input
    // this epoch had claimed: the work was declined, not done.
    case 'blocked':
      return 'refusal'
    // A clean ending and no accounting turn at all share one rule: the epoch
    // finished what it was given unless a cancelled queue says otherwise.
    case undefined:
    case 'completed':
      return droppedUnrun ? 'aborted' : 'completed'
    /* v8 ignore next 4 -- `forked` appears only in constructor seed history, while
     * this function reads an epoch-owned suffix. `TurnEndReason` is merge-extensible,
     * so a backend-added variant cannot be listed; treating an unnameable reason as
     * success would report failed work as completed. */
    default:
      return 'error'
  }
}

/** Measure only a parked join, excluding unrelated dispatch and ledger latency.
 * @param ctx Runtime providing optional durable accounting.
 * @param parent Waiting session whose existing run supplies trusted identity.
 * @param waits Already-created work promises to join.
 * @returns Resolves after the wait facts have been acknowledged.
 */
export async function awaitChildWork(ctx: Context, parent: Agent, waits: readonly Promise<unknown>[]): Promise<void> {
  if (waits.length === 0) return
  const ledger = ctx.get('sessionLedger')
  if (ledger === undefined) { await Promise.all(waits); return }
  const startedAt = Date.now()
  const started = performance.now()
  let endedAt = startedAt
  let durationMs = 0
  const joined = Promise.all(waits).finally(() => {
    endedAt = Date.now()
    durationMs = performance.now() - started
  })
  // Observe failures immediately even while durable identity is being loaded.
  void joined.catch(() => undefined)
  const snapshot = await ledger.snapshot({ sessionId: parent.id })
  const row = snapshot.rows.findLast(item => item.kind !== 'event' && item.start.sessionId === parent.id)
  if (row === undefined || row.kind === 'event') throw new SubagentError('Waiting session ledger identity is unavailable', 'LEDGER_UNAVAILABLE')
  try { await joined } finally {
    const envelope = { schemaVersion: 1 as const, nodeId: row.start.nodeId, runId: row.start.runId, sessionId: parent.id }
    assertLedgerWrite(await ledger.appendEvent({ ...envelope, eventId: brandString<LedgerEventId>(randomUUID()),
      observedAt: endedAt, kind: 'wait/start', interval: { kind: 'subagent', startedAt } }))
    assertLedgerWrite(await ledger.appendEvent({ ...envelope, eventId: brandString<LedgerEventId>(randomUUID()),
      observedAt: endedAt, kind: 'wait/end', interval: { kind: 'subagent', startedAt, endedAt, durationMs } }))
  }
}

/** Fail closed when an idempotent append reports divergent durable content. */
function assertLedgerWrite(result: LedgerAppendResult): void {
  if (result.kind === 'conflict') throw new SubagentError('Subagent ledger append conflicted', 'LEDGER_CONFLICT')
}

/** Render any listener-thrown value without letting coercion escape containment. */
function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}
