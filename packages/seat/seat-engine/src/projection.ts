/** Rebuildable engine views; only synchronized decisions may enter this projection. */
import { digest, EngineError } from './journal.ts'
import type { SessionId } from '@panedesk/dsh-session'
import type {
  EngineDecision, EngineOpenData, EngineTriggerData, PendingSeatItem, QueueItemId,
  SeatProjectId, SeatProjectPolicy, ResourceReservation, SeatCallbackDelivery,
  CallbackId, ChildAdmissionTicket, ChildTicketId, SeatBudgetSnapshot, OwnerEpoch,
} from '@panedesk/dsh-seat'

/** Replay state is instance-owned and contains no independent durable truth. */
export class EngineProjection {
  /** Last contiguous committed decision sequence. */
  sequence = 0
  /** Verified decisions in replay order for historical queries. */
  readonly decisions: EngineDecision[] = []
  /** Unopened queue items, removed on cancellation or opening. */
  readonly pending = new Map<QueueItemId, PendingSeatItem>()
  /** Queue identities with committed reminder approval. */
  readonly approved = new Set<QueueItemId>()
  /** Accepted trigger data keyed by durable deduplication identity. */
  readonly dedup = new Map<string, EngineTriggerData>()
  /** Latest committed project mode and revision. */
  readonly policies = new Map<SeatProjectId, SeatProjectPolicy>()
  /** Latest opening progress for each engine-owned Session. */
  readonly opens = new Map<SessionId, EngineOpenData>()
  /** Current reservations retained until matching owner release. */
  readonly resources = new Map<SessionId, ResourceReservation>()
  /** Latest durable delivery state for each callback. */
  readonly callbacks = new Map<CallbackId, SeatCallbackDelivery>()
  /** Latest admission state for each child ticket. */
  readonly children = new Map<ChildTicketId, ChildAdmissionTicket>()
  /** Latest committed budget evidence for each Session. */
  readonly budgets = new Map<SessionId, SeatBudgetSnapshot>()
  /** Released owner epochs that must not regain authority. */
  readonly fenced = new Set<OwnerEpoch>()
  /** Latest close barrier, including released pre-archive failures. */
  readonly closing = new Map<SessionId, import('@panedesk/dsh-seat').EngineCloseData>()
  /** Committed close outcomes indexed by Session. */
  readonly closed = new Map<SessionId, import('@panedesk/dsh-seat').EngineCloseData>()
  /** Latest replacement progress indexed by replacement identity. */
  readonly replacements = new Map<import('@panedesk/dsh-seat').ReplacementId, import('@panedesk/dsh-seat').EngineReplacementData>()
  /** Latest repository checkpoint indexed by repository and ref. */
  readonly git = new Map<string, import('@panedesk/dsh-seat').EngineGitCheckpoint>()
  /** Latest maintenance evidence indexed by Session. */
  readonly keepalive = new Map<SessionId, import('@panedesk/dsh-seat').EngineKeepAliveData>()
  /** Maintenance outcomes indexed by Session and operation identity. */
  readonly renewals = new Map<string, import('@panedesk/dsh-seat').EngineKeepAliveData>()

  /** Reject conflicting terminal summaries before journal append or replay mutation.
   * @param decision - complete candidate frame.
   */
  validate(decision: EngineDecision): void {
    const replacements = new Map(this.replacements)
    const closed = new Map(this.closed)
    for (const effect of decision.effects) {
      if (effect.kind === 'window/replacement') {
        const previous = replacements.get(effect.data.replacementId)
        if (previous && (previous.phase === 'completed' || previous.phase === 'failed')
          && digest(previous) !== digest(effect.data)) {
          throw new EngineError('state-conflict', 'Replacement terminal summary conflicts with its first outcome')
        }
        replacements.set(effect.data.replacementId, effect.data)
      }
      if (effect.kind === 'window/closed') {
        const previous = closed.get(effect.data.sessionId)
        if (previous && digest(previous) !== digest(effect.data)) throw new EngineError('state-conflict', 'Terminal close already exists')
        closed.set(effect.data.sessionId, effect.data)
      }
      if (effect.kind === 'window/closing' && closed.has(effect.data.sessionId)) {
        throw new EngineError('state-conflict', 'Closed window cannot acquire or release a close barrier')
      }
    }
  }

  /** Apply a contiguous committed frame; gaps invalidate this view.
   * @param decision - verified durable frame.
   */
  apply(decision: EngineDecision): void {
    if (decision.sequence !== this.sequence + 1) throw new Error('Engine sequence gap')
    this.validate(decision)
    for (const effect of decision.effects) {
      switch (effect.kind) {
        case 'trigger/accepted': case 'trigger/coalesced': case 'trigger/deduplicated':
          if (effect.kind !== 'trigger/deduplicated') {
            this.dedup.set(effect.data.deduplication.key, effect.data)
            this.pending.set(effect.data.pending.queueItemId, effect.data.pending)
          }
          break
        case 'queue/pending': this.pending.set(effect.data.queueItemId, effect.data); break
        case 'queue/approved':
          this.pending.set(effect.data.pending.queueItemId, effect.data.pending)
          this.approved.add(effect.data.pending.queueItemId)
          break
        case 'queue/cancelled':
          this.pending.delete(effect.data.pending.queueItemId)
          this.approved.delete(effect.data.pending.queueItemId)
          break
        case 'mode/changed': this.policies.set(effect.data.policy.projectId, effect.data.policy); break
        case 'open/intent': case 'open/created': case 'open/configured': case 'open/opening-failed':
          this.opens.set(effect.data.sessionId, effect.data)
          if ((this.budgets.get(effect.data.sessionId)?.budgetRevision ?? -1) <= effect.data.budget.budgetRevision) {
            this.budgets.set(effect.data.sessionId, effect.data.budget)
          }
          if (effect.triggerId) {
            for (const [id, item] of this.pending) {
              if (item.sources.some(source => source.triggerId === effect.triggerId)) this.pending.delete(id)
            }
          }
          break
        case 'resource/reserved': this.resources.set(effect.data.owner.sessionId, effect.data); break
        case 'resource/released': {
          const current = this.resources.get(effect.data.owner.sessionId)
          if (current?.owner.ownerEpoch === effect.data.owner.ownerEpoch
            && current.owner.resourceRevision === effect.data.owner.resourceRevision) {
            this.resources.delete(effect.data.owner.sessionId)
            this.fenced.add(effect.data.owner.ownerEpoch)
          }
          break
        }
        case 'callback/pending': case 'callback/attempted': case 'callback/delivered':
          this.callbacks.set(effect.data.payload.callbackId, effect.data); break
        case 'child/queued': case 'child/admitted': case 'child/released':
          this.children.set(effect.data.ticketId, effect.data); break
        case 'budget/warning': case 'budget/stopped': this.budgets.set(effect.data.sessionId, effect.data); break
        case 'budget/reconfigured': this.budgets.set(effect.data.budget.sessionId, effect.data.budget); break
        case 'window/closing': this.closing.set(effect.data.sessionId, effect.data); break
        case 'window/closed':
          this.closed.set(effect.data.sessionId, effect.data)
          this.closing.set(effect.data.sessionId, effect.data)
          break
        case 'window/replacement': this.replacements.set(effect.data.replacementId, effect.data); break
        case 'cache/keepalive': case 'cache/keepalive-skipped':
          this.keepalive.set(effect.data.sessionId, effect.data)
          this.renewals.set(JSON.stringify([effect.data.sessionId, effect.data.operationId]), effect.data)
          break
        case 'git/checkpoint': this.git.set(JSON.stringify([effect.data.repositoryId, effect.data.ref]), effect.data); break
        // These facts are queried directly; they own no second mutable index here.
        case 'queue/reminded':
        case 'open/rejected': case 'source/rejected': case 'seat/binding':
        case 'gate/hit': case 'gate/expired':
        case 'wait/registered': case 'wait/satisfied': case 'wait/woken': case 'wait/cancelled':
        case 'job/observed': case 'memory/audit': case 'report/submitted': case 'report/revoked': break
        default: { const unreachable: never = effect; throw new Error(`Unknown engine effect: ${String(unreachable)}`) }
      }
    }
    this.decisions.push(decision)
    this.sequence = decision.sequence
  }
}
