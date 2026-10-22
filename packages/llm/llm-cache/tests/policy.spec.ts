import { describe, expect, it } from 'vitest'
import { resolveCachePolicy } from '../src/policy.ts'
import type { CacheRoute } from '../src/policy.ts'

describe('cache policy', () => {
  it.each([
    ['anthropic', '1h', 3600], ['openai-responses', '12h', 43200], ['openai-chat', '30m', 1800],
    ['automatic', 'auto', undefined], ['unsupported', 'default', undefined],
  ] as const)('resolves the default for %s', (capability, retention, ttlSeconds) => {
    const route: CacheRoute = { provider: 'route-a', modelFamily: 'family-a', capability }
    expect(resolveCachePolicy({ retention: 'default' }, route, 'session-a')).toMatchObject({ control: { retention, key: 'session-a' } })
    expect(resolveCachePolicy({ retention: 'default' }, route, 'session-a').ttlSeconds).toBe(ttlSeconds)
    if (capability === 'openai-chat') expect(resolveCachePolicy({ retention: 'default' }, route, 'session-a').downgradeReason).toBe('non-responses-api')
  })
  it('validates explicit tiers and never claims automatic families have a TTL switch', () => {
    const route: CacheRoute = { provider: 'route-a', modelFamily: 'family-a', capability: 'anthropic' }
    for (const retention of ['none', '5m', '1h'] as const) {
      expect(resolveCachePolicy({ retention, stableKey: 'custom' }, route, 'session-a').control).toEqual({ retention, key: 'custom' })
    }
    expect(() => resolveCachePolicy({ retention: '12h' }, route, 'a')).toThrow('Unsupported')
    expect(() => resolveCachePolicy({ retention: '1h' }, { ...route, capability: 'automatic' }, 'a')).toThrow('Unsupported')
    expect(resolveCachePolicy({ retention: 'none' }, { ...route, capability: 'unsupported' }, 'a').mode).toBe('disabled')
  })
})
