import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('cache policy scaffold', () => {
  it('supports every retention policy without activating services', () => {
    expect(name).toBe('llm-cache')
    expect(inject).toEqual([])
    for (const retention of ['default', 'none', '5m', '1h', '30m', '12h', 'auto'] as const) {
      const config = Config({ policy: { retention }, keepalive: {} })
      expect(config.policy.retention).toBe(retention)
      expect(config.keepalive.enabled).toBe(false)
      expect(config.concurrency).toEqual([])
    }
  })
})
