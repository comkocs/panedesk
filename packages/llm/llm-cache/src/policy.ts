/** Explicit retention resolution by configured provider family and API capability. */
import type { CachePolicy, ResolvedCachePolicy } from './types.ts'

/** Route capability, supplied by trusted deployment configuration rather than model-name guessing. */
export interface CacheRoute {
  provider: string
  modelFamily: string
  capability: 'anthropic' | 'openai-responses' | 'openai-chat' | 'automatic' | 'unsupported'
}

/** Resolve a session policy before freezing the request.
 * @param policy - requested retention; unsupported explicit selections reject.
 * @param route - trusted family/API capability.
 * @param sessionKey - session identity used when no custom key was selected.
 * @returns effective controls and any required downgrade evidence.
 */
export function resolveCachePolicy(policy: CachePolicy, route: CacheRoute, sessionKey: string): ResolvedCachePolicy {
  const key = policy.stableKey ?? sessionKey
  let retention = policy.retention
  let downgradeReason: string | undefined
  if (retention === 'default') {
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
