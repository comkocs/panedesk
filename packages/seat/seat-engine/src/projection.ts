/** Rebuildable engine views; only synchronized decisions may enter this projection. */
import type { SessionId } from '@panedesk/dsh-session'
import type {
  EngineDecision, EngineOpenData, EngineTriggerData, PendingSeatItem, QueueItemId,
  SeatProjectId, SeatProjectPolicy, ResourceReservation, SeatCallbackDelivery,
  CallbackId, ChildAdmissionTicket, ChildTicketId, SeatBudgetSnapshot, OwnerEpoch,
} from '@panedesk/dsh-seat'

/** Replay state is instance-owned and contains no independent durable truth. */
export class EngineProjection {
  sequence = 0
  readonly decisions: EngineDecision[] = []
  readonly pending = new Map<QueueItemId, PendingSeatItem>()
  readonly approved = new Set<QueueItemId>()
  readonly dedup = new Map<string, EngineTriggerData>()
  readonly policies = new Map<SeatProjectId, SeatProjectPolicy>()
  readonly opens = new Map<SessionId, EngineOpenData>()
  readonly resources = new Map<SessionId, ResourceReservation>()
  readonly callbacks = new Map<CallbackId, SeatCallbackDelivery>()
  readonly children = new Map<ChildTicketId, ChildAdmissionTicket>()
  readonly budgets = new Map<SessionId, SeatBudgetSnapshot>()
  readonly fenced = new Set<OwnerEpoch>()

  /** Apply a contiguous committed frame; gaps invalidate this view.
   * @param decision - verified durable frame.
   */
  apply(decision: EngineDecision): void {
    if (decision.sequence !== this.sequence + 1) throw new Error('Engine sequence gap')
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
          this.budgets.set(effect.data.sessionId, effect.data.budget)
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
        // These facts are queried directly; they own no second mutable index here.
        case 'open/rejected': case 'source/rejected': case 'seat/binding': case 'window/closing':
        case 'window/closed': case 'window/replacement': case 'gate/hit': case 'gate/expired':
        case 'wait/registered': case 'wait/satisfied': case 'wait/woken': case 'wait/cancelled':
        case 'job/observed': case 'memory/audit': case 'report/submitted': case 'report/revoked': break
        default: { const unreachable: never = effect; throw new Error(`Unknown engine effect: ${String(unreachable)}`) }
      }
    }
    this.decisions.push(decision)
    this.sequence = decision.sequence
  }
}
