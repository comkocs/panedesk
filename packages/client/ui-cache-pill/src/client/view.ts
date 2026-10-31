/** Cache view as the pill draws it. The host bridge owns the numbers; this only names the states. */
import type { SessionId } from '@panedesk/dsh-session/types'

/** One window's countdown. `unknown` is shown as unknown; it is never turned into a duration. */
export interface CacheRow {
  readonly sessionId: SessionId
  readonly role: 'main' | 'subagent'
  readonly kind: 'estimated' | 'automatic' | 'disabled' | 'unknown'
  readonly seconds?: number
  readonly evidenceAt?: number
  readonly ttlSeconds?: number
  readonly cacheReadTokens?: number
}

/** Tiers an explicit route may offer, in policy-table order. */
export type CacheTier = 'none' | '5m' | '1h' | '30m' | '12h'

/** What one read of the bridge produced. */
export type CacheRead =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'denied' }
  | { readonly status: 'error' }
  | { readonly status: 'empty' }
  | { readonly status: 'ready'; readonly rows: readonly CacheRow[]; readonly tiers: readonly CacheTier[]; readonly retention?: CacheTier; readonly complete?: boolean }

/** A tier switch the panel reports back. */
export type TierWrite =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' }
  | { readonly status: 'saved' }
  | { readonly status: 'failed' }

/**
 * Format a remaining duration without rounding past a minute boundary the caller did not cross.
 * @param seconds - whole seconds left.
 * @returns a short reading such as `45s` or `4m 5s`.
 */
export function remainingParts(seconds: number): { key: 'seconds' | 'minutesSeconds' | 'hoursMinutesSeconds'; values: Record<string, string> } {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < 60) return { key: 'seconds', values: { count: String(whole) } }
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  if (minutes < 60) return { key: 'minutesSeconds', values: { minutes: String(minutes), seconds: String(rest) } }
  return { key: 'hoursMinutesSeconds', values: { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60), seconds: String(rest) } }
}
