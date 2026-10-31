/** Authorized cache readings for a session and its readable descendants. */
import type { SessionId } from '@panedesk/dsh-session/types'
import type { CacheRetention } from '@panedesk/dsh-llm/types'

/** An explicit tier selectable by a supported route. */
export type CacheTier = Exclude<CacheRetention, 'default' | 'auto'>

/** Evidence-based countdown; automatic routes expose only observed cache reads. */
export type SessionCacheRemainingRow = {
  readonly sessionId: SessionId
  readonly role: 'main' | 'subagent'
  readonly cacheReadTokens?: number
} & (
  | { readonly kind: 'estimated'; readonly seconds: number; readonly evidenceAt: number; readonly ttlSeconds: number }
  | { readonly kind: 'automatic' | 'disabled' | 'unknown' }
)

/** Main session whose cache evidence the caller may read. */
export interface SessionCacheViewRequest {
  readonly sessionId: SessionId
}

/** Cache evidence and the actual tier supported by the current live route. */
export interface SessionCacheView {
  readonly rows: readonly SessionCacheRemainingRow[]
  readonly tiers: readonly CacheTier[]
  readonly adjustable: boolean
  readonly retention?: CacheRetention
  /** Missing or incomplete evidence is never reported as a complete descendant list. */
  readonly complete: boolean
}

/** Store one supported tier without dispatching a model call. */
export interface SessionCacheTierRequest {
  readonly sessionId: SessionId
  readonly retention: CacheTier
}
