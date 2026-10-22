import { describe, expect, it } from 'vitest'
import AgentPreset from '../src/index.ts'

describe('execution policy configuration', () => {
  it('keeps an omitted policy absent instead of materializing an empty object', () => {
    expect(AgentPreset.Config({ id: 'standard', plugins: [] }).executionPolicy).toBeUndefined()
  })

  it('parses complete definitions and rejects missing route fields', () => {
    const executionPolicy = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high',
      allowedTools: ['one', 'two', 'three'], rulesId: 'rules-a', version: '1', digest: 'rules-digest' }
    expect(AgentPreset.Config({ id: 'standard', plugins: [], executionPolicy }).executionPolicy).toEqual(executionPolicy)
    expect(() => AgentPreset.Config({ id: 'standard', plugins: [], executionPolicy: { ...executionPolicy, model: '' } })).toThrow()
  })
})
