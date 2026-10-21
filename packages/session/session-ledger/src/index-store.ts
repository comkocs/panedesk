/** Rebuildable uniqueness indexes; durable journal records remain the only source of truth. */
import { createHash } from 'node:crypto'
import type { LedgerEvent } from './types.ts'

/** Reconstructed event and terminal-slot indexes with explicit conflicting facts. */
export interface LedgerIndex {
  events: Map<string, LedgerEvent>
  slots: Map<string, LedgerEvent>
  conflicts: { existing: LedgerEvent; incoming: LedgerEvent }[]
}

/** Serialize JSON with sorted object keys and stable array order.
 * @param value - JSON-serializable runtime fact.
 * @returns Canonical JSON text, rejecting lossy nonfinite numbers and unsupported values.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  throw new Error('Ledger facts must be lossless JSON values')
}

/** Hash exact UTF-8 bytes.
 * @param text - Serialized content.
 * @returns Lowercase SHA-256 digest.
 */
export function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Return the uniqueness key for paired lifecycle/call facts.
 * @param event - Complete journal fact.
 * @returns Semantic slot, or undefined for independent observations.
 */
export function uniqueSlot(event: LedgerEvent): string | undefined {
  switch (event.kind) {
    case 'call/start': case 'call/end': return JSON.stringify([event.kind, event.data.callId])
    case 'run/start': case 'run/end': return JSON.stringify([event.kind, event.data.runId])
    case 'compaction': return JSON.stringify([event.kind, event.sessionId, event.committedSeq])
    default: return undefined
  }
}

/** Compare semantic slot contents without confusing new transport envelopes with new facts.
 * @param event - Paired or auxiliary fact.
 * @returns Canonical fact text used for slot equality.
 */
export function slotContent(event: LedgerEvent): string {
  return canonicalJson('data' in event ? event.data : event)
}

/** Rebuild indexes without trusting any previously written cache or input ordering.
 * @param events - Validated committed records from every scanned partition.
 * @returns Unique indexes and all unequal collisions, without overwriting first facts.
 */
export function rebuildIndex(events: readonly LedgerEvent[]): LedgerIndex {
  const index: LedgerIndex = { events: new Map(), slots: new Map(), conflicts: [] }
  for (const event of events) {
    const prior = index.events.get(event.eventId)
    const key = uniqueSlot(event)
    const slot = key === undefined ? undefined : index.slots.get(key)
    if (prior && canonicalJson(prior) !== canonicalJson(event)) index.conflicts.push({ existing: prior, incoming: event })
    else if (slot && slotContent(slot) !== slotContent(event)) index.conflicts.push({ existing: slot, incoming: event })
    else {
      if (!prior) index.events.set(event.eventId, event)
      if (key !== undefined && !slot) index.slots.set(key, event)
    }
  }
  return index
}
