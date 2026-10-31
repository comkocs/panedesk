/** One client plugin generation owns retention announcements across resource and modal reopenings. */
import type { ApprovalQueueView } from '../types.ts'

/** Resource-local announcement history; no deadlines are calculated in the browser. */
export class ApprovalObservations {
  private readonly alerts = new Map<string, NonNullable<ApprovalQueueView['alerts']>[number]>()

  /** Attach each observed threshold once, retaining stable announcement identities.
   * @param view - Authoritative engine projection and committed refusals.
   * @returns Queue observation with announcement history for this plugin lifetime.
   */
  observe(view: ApprovalQueueView): ApprovalQueueView {
    for (const item of view.items) {
      const retention = item.retention
      if (!retention || retention.phase === 'retained') continue
      const id = `${item.queueItemId}:${retention.since}:${retention.phase}`
      if (!this.alerts.has(id)) this.alerts.set(id, { id, seat: item.seat, phase: retention.phase })
    }
    for (const { item } of view.rejected ?? []) {
      const id = `${item.queueItemId}:terminal:expired`
      if (![...this.alerts.values()].some(alert => alert.phase === 'expired' && alert.id.startsWith(`${item.queueItemId}:`))) {
        this.alerts.set(id, { id, seat: item.seat, phase: 'expired' })
      }
    }
    return { ...view, alerts: [...this.alerts.values()] }
  }
}
