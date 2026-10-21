import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('ledger watcher scaffold', () => {
  it('declares bounded defaults without activating services', () => {
    expect(name).toBe('ledger-watch')
    expect(inject).toEqual([])
    expect(Config({})).toEqual({ intervalMs: 2000, settlementBudgetMs: 10000, scanOnStart: true })
  })
})
