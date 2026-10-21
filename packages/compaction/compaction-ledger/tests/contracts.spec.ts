import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('compaction ledger scaffold', () => {
  it('declares bounded checkpoint defaults without activating services', () => {
    expect(name).toBe('compaction-ledger')
    expect(inject).toEqual([])
    expect(Config({})).toEqual({ recentEventLimit: 10, maxTokens: 1024, snapshotRetries: 2 })
  })
})
