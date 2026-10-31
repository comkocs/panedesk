/** Retention announcements survive plugin rebuilds and stay bounded. */
import type { ApprovalQueueView } from '../types.ts'

/** Browser key for the bounded announcement history. */
const STORAGE_KEY = 'dsh.seat-approvals.alerts.v1'
/** Oldest announcements are dropped once the history passes this many rows. */
const ALERT_LIMIT = 200

/** One stored announcement, small enough to round-trip through local storage. */
interface StoredAlert { id: string; seat: string; phase: 'expiring' | 'expired' }

/** Persisted document: visible rows plus terminal identities already announced. */
interface StoredHistory { alerts: StoredAlert[]; settled: string[] }

/** Read the persisted history. A missing or unreadable document starts empty.
 * @param storage - the browser store, or undefined outside a browser.
 * @returns the stored announcements, oldest first, or an empty list.
 */
function readStored(storage: Storage | undefined): StoredHistory {
  const empty = { alerts: [], settled: [] }
  if (storage === undefined) return empty
  let raw: string | null
  try { raw = storage.getItem(STORAGE_KEY) } catch { return empty }
  if (raw === null) return empty
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return empty }
  const rows = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { alerts?: unknown }).alerts) ? (parsed as { alerts: unknown[] }).alerts : undefined
  const settled = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { settled?: unknown }).settled)
    ? (parsed as { settled: unknown[] }).settled.filter((id): id is string => typeof id === 'string') : []
  if (rows === undefined) return empty
  return { settled, alerts: rows.flatMap((row): StoredAlert[] => {
    if (typeof row !== 'object' || row === null) return []
    const { id, seat, phase } = row as { id?: unknown; seat?: unknown; phase?: unknown }
    if (typeof id !== 'string' || typeof seat !== 'string' || (phase !== 'expiring' && phase !== 'expired')) return []
    return [{ id, seat, phase }]
  }).slice(-ALERT_LIMIT) }
}

/** Write the bounded history. A storage failure keeps the in-memory copy.
 * @param storage - the browser store, or undefined outside a browser.
 * @param alerts - the announcements to keep.
 */
function writeStored(storage: Storage | undefined, history: StoredHistory): void {
  if (storage === undefined) return
  const document = { alerts: history.alerts.slice(-ALERT_LIMIT), settled: history.settled }
  try { storage.setItem(STORAGE_KEY, JSON.stringify(document)) } catch { /* the in-memory copy still dedupes this lifetime */ }
}

/** Resource-local announcement history, restored from local storage across rebuilds. */
export class ApprovalObservations {
  private readonly alerts: StoredAlert[]
  /** Terminal queue identities already announced, including rows dropped by the limit. */
  private readonly settled = new Set<string>()

  /** Restore the bounded history.
   * @param storage - the browser store; tests pass their own, production uses `localStorage`.
   */
  constructor(private readonly storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage) {
    const history = readStored(storage)
    this.alerts = history.alerts
    for (const id of history.settled) this.settled.add(id)
  }

  /** Attach each observed threshold once, retaining stable announcement identities.
   * A poll that first arrives inside the five-minute window still announces it.
   * @param view - Authoritative engine projection and committed refusals.
   * @returns Queue observation with the bounded announcement history.
   */
  observe(view: ApprovalQueueView): ApprovalQueueView {
    const known = new Set(this.alerts.map(alert => alert.id))
    const record = (alert: StoredAlert): void => {
      if (known.has(alert.id)) return
      known.add(alert.id)
      this.alerts.push(alert)
      if (alert.phase === 'expired') this.settled.add(alert.id.slice(0, alert.id.indexOf(':')))
      if (this.alerts.length > ALERT_LIMIT) this.alerts.splice(0, this.alerts.length - ALERT_LIMIT)
    }
    for (const item of view.items) {
      const retention = item.retention
      if (!retention || retention.phase === 'retained') continue
      record({ id: `${item.queueItemId}:${retention.since}:${retention.phase}`, seat: item.seat, phase: retention.phase })
    }
    for (const { item } of view.rejected ?? []) {
      if (this.settled.has(item.queueItemId)) continue
      record({ id: `${item.queueItemId}:terminal:expired`, seat: item.seat, phase: 'expired' })
    }
    const bounded = this.alerts.slice(-ALERT_LIMIT)
    if (bounded.length !== this.alerts.length) this.alerts.splice(0, this.alerts.length - bounded.length)
    writeStored(this.storage, { alerts: this.alerts, settled: [...this.settled] })
    return { ...view, alerts: this.alerts.map(alert => ({ ...alert, seat: alert.seat as NonNullable<ApprovalQueueView['alerts']>[number]['seat'] })) }
  }
}
