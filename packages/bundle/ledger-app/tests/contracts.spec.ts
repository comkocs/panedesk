import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('offline ledger scaffold', () => {
  it('defaults to queries without activating runtime services', () => {
    expect(name).toBe('ledger-app')
    expect(inject).toEqual([])
    expect(Config({})).toEqual({ mode: 'query' })
  })
})
