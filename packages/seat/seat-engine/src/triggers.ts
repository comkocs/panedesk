/** All six trigger families share durable deduplication, coalescing and project policy. */
import { randomUUID } from 'node:crypto'
import type { AcceptTriggerResult, EngineEffect, EngineEventId, PendingSeatItem, QueueItemId, SeatEngineConfig, SeatProjectPolicy, TriggerEnvelope, EngineTriggerData, SeatRejected, SeatErrorCode } from '@panedesk/dsh-seat'
import { canonical, digest, EngineJournal, EngineError } from './journal.ts'
import { effectiveMode } from './admission.ts'
import { SourceRegistry } from './sources.ts'

/** Safe machine rejection carries no source body or credential material.
 * @param code - stable failure classification.
 * @param message - safe diagnostic.
 * @returns actionable rejection with no committed business effect.
 */
export function rejected(code: SeatErrorCode, message: string): SeatRejected {
  return { status: 'rejected', error: { code, message, alternative: 'Inspect engine state and retry with the same operation identity.',
    retryable: code === 'unavailable', effectState: 'none' } }
}
/** Assign an effect identity while preserving its discriminated payload.
 * @param effect - complete fact except for its generated event identity.
 * @returns identified effect.
 */
export function fact(effect: EngineEffect extends infer E ? E extends EngineEffect ? Omit<E, 'eventId'> : never : never): EngineEffect {
  return { ...effect, eventId: randomUUID() as EngineEventId }
}
/** Reminders share the approval-entry commit and retain its queue revision as their identity.
 * @param pending - queue state being committed.
 * @param previous - prior queue state, or undefined for a new item.
 * @returns one reminder only when entering approval.
 */
export function reminderEffects(pending: PendingSeatItem, previous: PendingSeatItem | undefined): EngineEffect[] {
  if (pending.reason !== 'approval' || previous?.reason === 'approval') return []
  const source = pending.sources[0]
  if (!source) throw new EngineError('invalid-request', 'Approval reminder requires its first trigger')
  return [{ kind: 'queue/reminded', eventId: digest(['queue/reminded', pending.queueItemId, pending.stateVersion]) as string as EngineEventId,
    seat: pending.seat, triggerId: source.triggerId, data: { queueItemId: pending.queueItemId, seat: pending.seat,
      projectId: pending.projectId, triggerKind: pending.triggerKind, reason: 'approval', triggerId: source.triggerId,
      sequence: pending.sequence, stateVersion: pending.stateVersion, remindedAt: new Date().toISOString() } }]
}
/** Authenticated ingress acknowledges only the complete synchronized decision. */
export class TriggerRegistry {
  constructor(private readonly journal: EngineJournal, private readonly sources: SourceRegistry,
    private readonly config: SeatEngineConfig) {}

  /** Admit one host-stamped event, preserving all callback subscribers when coalesced.
   * @param envelope - adapter-authenticated bounded payload.
   * @param ruleMode - current rule restriction resolved by the engine.
   * @param frozenOpen - configuration and text resolved at acceptance.
   * @returns stable acceptance or explicit refusal.
   */
  async accept(envelope: TriggerEnvelope, ruleMode?: import('@panedesk/dsh-seat').EngineMode,
    frozenOpen?: import('@panedesk/dsh-seat').SeatFrozenOpen,
    authorize?: (effects: readonly EngineEffect[]) => import('./authorization-storage.ts').AuthorizationDecision['effects']): Promise<AcceptTriggerResult> {
    try {
      const result = await this.sources.use<AcceptTriggerResult>(envelope.sourceId, async (source): Promise<AcceptTriggerResult> => {
        if (!source.kinds.includes(envelope.kind) || envelope.evidence.kind !== envelope.kind || envelope.callbackRef !== envelope.sourceId) return rejected('unauthorized',
          'Source is not authorized for this trigger')
        if (Buffer.byteLength(canonical(envelope)) > this.config.maxSourceBytes) return rejected('source-payload-too-large',
          'Source event exceeds its byte limit')
        if (envelope.cause && envelope.cause.depth >= this.config.maxCauseDepth) return rejected('causal-depth-exceeded',
          'Trigger causal chain requires manual review')
        const now = Date.now(), receivedAt = new Date(now).toISOString()
        const trigger = { ...envelope, receivedAt }
        const bucket = envelope.eventId ? null : Math.floor(now / this.config.dedupWindowMs)
        const contentDigest = digest({ kind: trigger.kind, evidence: trigger.evidence, seat: trigger.seat,
          projectId: trigger.projectId, data: trigger.data, taskId: trigger.taskId, callbackRef: trigger.callbackRef,
          ...(trigger.openingContext ? { openingContext: trigger.openingContext, relatedTaskIds: trigger.relatedTaskIds } : {}) })
        const key = canonical([trigger.sourceId, trigger.eventId ?? contentDigest, bucket])
        let result: AcceptTriggerResult = rejected('unavailable', 'Ingress did not commit')
        const build = (view: import('./projection.ts').EngineProjection): readonly EngineEffect[] => {
          const checkpoint = trigger.evidence.kind === 'git' ? [fact({ kind: 'git/checkpoint', data: {
            repositoryId: trigger.evidence.repositoryId, ref: trigger.evidence.ref,
            objectId: trigger.evidence.newObjectId, sequence: trigger.evidence.observationSequence,
          } })] : []
          const existing = view.dedup.get(key)
          if (existing) {
            if (existing.deduplication.digest !== contentDigest) { result = rejected('event-id-conflict',
              'Event identity has different content'); return [] }
            result = { status: 'duplicate', triggerId: trigger.triggerId, originalTriggerId: existing.trigger.triggerId,
              queueItemId: existing.pending.queueItemId }
            return [fact({ kind: 'trigger/deduplicated', triggerId: trigger.triggerId, seat: trigger.seat,
              data: { ...existing, trigger, originalTriggerId: existing.trigger.triggerId } })]
          }
          const policy: SeatProjectPolicy = view.policies.get(trigger.projectId) ?? { projectId: trigger.projectId,
            mode: 'remind', modeChosen: false, revision: 0 }
          const mode = trigger.kind === 'manual' ? 'auto' : effectiveMode(policy.mode, ruleMode)
          if (mode === 'off') {
            result = rejected('disabled', 'Automatic triggering is disabled')
            return [...checkpoint, fact({ kind: 'source/rejected', seat: trigger.seat, data: { sourceId: trigger.sourceId,
              sourceEventId: trigger.eventId ?? null, digest: contentDigest, error: result.error } })]
          }
          const previous = [...view.pending.values()].find(item => item.seat === trigger.seat
            && item.projectId === trigger.projectId && item.triggerKind === trigger.kind
            && (trigger.kind !== 'external' || !frozenOpen?.definition.rules.some(rule => rule.trigger.kind === 'external')
              || item.sources[0]?.sourceId === trigger.sourceId
              && item.sources[0].evidence.kind === 'external' && trigger.evidence.kind === 'external'
              && item.sources[0].evidence.eventType === trigger.evidence.eventType)
            && canonical(item.frozenOpen?.openingContext?.reference ?? null) === canonical(frozenOpen?.openingContext?.reference ?? null)
            && (trigger.evidence.kind !== 'handoff-timeout' || item.handoffTimeout?.messageId === trigger.evidence.messageId))
          const sources = [...(previous?.sources ?? []), trigger]
          const retainedOpen = previous?.frozenOpen ?? frozenOpen
          const pending: PendingSeatItem = {
            ...(retainedOpen ? { frozenOpen: structuredClone(retainedOpen) } : {}),
            queueItemId: previous?.queueItemId ?? randomUUID() as QueueItemId,
            seat: trigger.seat, projectId: trigger.projectId, triggerKind: trigger.kind,
            action: trigger.kind === 'handoff-timeout' ? 'wake-sender' : 'open',
            ...(trigger.evidence.kind === 'handoff-timeout' ? { handoffTimeout: trigger.evidence } : {}),
            sequence: previous?.sequence ?? view.sequence + 1, effectiveMode: mode,
            reason: mode === 'remind' ? 'approval' : 'provider-unavailable', blockedBy: [], sources,
            relatedTaskIds: [...new Set([...sources.flatMap(source => source.taskId ? [source.taskId] : []),
              ...(retainedOpen?.openingContext?.taskIds ?? [])])],
            queuedAt: previous?.queuedAt ?? receivedAt, stateVersion: (previous?.stateVersion ?? 0) + 1,
          }
          const data: EngineTriggerData = { trigger, pending, originalTriggerId: previous?.sources[0]?.triggerId ?? null,
            deduplication: { key, digest: contentDigest, receivedAt, bucket, sourceId: trigger.sourceId,
              eventId: trigger.eventId ?? null } }
          result = { status: previous ? 'coalesced' : 'accepted', triggerId: trigger.triggerId,
            queueItemId: pending.queueItemId, sequence: pending.sequence }
          const effects = [...checkpoint, fact({ kind: previous ? 'trigger/coalesced' : 'trigger/accepted', triggerId: trigger.triggerId,
            seat: trigger.seat, data }), ...reminderEffects(pending, previous)]
          return effects
        }
        if (authorize) await this.journal.commitAuthorization((view) => {
          const effects = build(view)
          return result.status === 'accepted' || result.status === 'coalesced' ? authorize(effects) : effects
        })
        else await this.journal.commit(build)
        return result
      })
      if (result.status === 'rejected' && result.error.code !== 'disabled') await this.auditRejection(envelope, result)
      return result
    } catch (error) {
      if (!(error instanceof EngineError)) throw error
      const result = rejected(error.code, error.message)
      await this.auditRejection(envelope, result)
      return result
    }
  }
  private async auditRejection(envelope: TriggerEnvelope, result: SeatRejected): Promise<void> {
    await this.journal.commit(() => [fact({ kind: 'source/rejected', seat: envelope.seat, data: {
      sourceId: envelope.sourceId, sourceEventId: envelope.eventId ?? null,
      digest: digest(envelope.data), error: result.error,
    } })])
  }
}
