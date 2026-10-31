/** Explicit retention resolution by configured provider family and API capability. */
import type { CacheRetention } from '@panedesk/dsh-llm'
import type { CachePolicy, ResolvedCachePolicy } from './types.ts'

/** Retention a route pins for selections that did not choose an explicit tier. */
export type RouteRetention = Exclude<CacheRetention, 'default'>

/** Route capability, supplied by trusted deployment configuration rather than model-name guessing. */
export interface CacheRoute {
  /** Registered provider identifier. */
  provider: string
  /** Explicit model family selected by deployment configuration. */
  modelFamily: string
  /** Cache controls supported by the serving API. */
  capability: 'anthropic' | 'openai-responses' | 'openai-chat' | 'automatic' | 'unsupported'
  /** Route-pinned tier for `default` selections; must be supported by {@link CacheRoute.capability}. */
  retention?: RouteRetention
}

/** Every retention tier the policy vocabulary accepts, in schema order. */
const RETENTIONS: readonly CacheRetention[] = ['default', 'none', '5m', '1h', '30m', '12h', 'auto']

/**
 * Validate one externally supplied selection without consulting route capability.
 * @param policy - caller-supplied selection whose shape must fail loud before storage.
 * @throws when retention is not a known tier or stableKey is not a string.
 */
export function validateCachePolicySelection(policy: CachePolicy): void {
  if (!RETENTIONS.includes(policy.retention)) throw new Error(`Unknown cache retention ${policy.retention}`)
  if (policy.stableKey !== undefined && typeof policy.stableKey !== 'string') {
    throw new Error('Cache stable key must be a string')
  }
}

/** Resolve a session policy before freezing the request.
 * @param policy - requested retention; unsupported explicit selections reject.
 * @param route - trusted family/API capability, whose optional pinned retention
 * serves `default` selections before the capability table.
 * @param sessionKey - session identity used when no custom key was selected.
 * @returns effective controls and any required downgrade evidence.
 */
export function resolveCachePolicy(policy: CachePolicy, route: CacheRoute, sessionKey: string): ResolvedCachePolicy {
  const key = policy.stableKey ?? sessionKey
  let retention = policy.retention
  let downgradeReason: string | undefined
  if (retention === 'default' && route.retention !== undefined) {
    retention = route.retention
  } else if (retention === 'default') {
    switch (route.capability) {
      case 'anthropic': retention = '1h'; break
      case 'openai-responses': retention = '12h'; break
      case 'openai-chat': retention = '30m'; downgradeReason = 'non-responses-api'; break
      case 'automatic': retention = 'auto'; break
      case 'unsupported': return { control: { retention: 'default', key }, mode: 'unknown' }
    }
  }
  const allowed = route.capability === 'anthropic' ? ['none', '5m', '1h']
    : route.capability === 'openai-responses' ? ['none', '30m', '12h']
      : route.capability === 'openai-chat' ? ['none', '30m']
        : route.capability === 'automatic' ? ['auto'] : ['none']
  if (!allowed.includes(retention)) throw new Error(`Unsupported cache retention ${retention} for ${route.provider}`)
  const ttlSeconds = retention === '5m' ? 300 : retention === '1h' ? 3600
    : retention === '30m' ? 1800 : retention === '12h' ? 43200 : undefined
  return {
    control: { retention, key },
    mode: retention === 'none' ? 'disabled' : retention === 'auto' ? 'automatic' : 'explicit',
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    ...(downgradeReason === undefined ? {} : { downgradeReason }),
  }
}
