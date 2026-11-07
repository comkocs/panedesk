// @vitest-environment jsdom
/**
 * Default selection for "Recognize models": the newest two models in each
 * family start checked. Display order follows creation time or server order.
 */
import { describe, expect, it } from 'vitest'
import type { LlmDiscoveredModel } from '@panedesk/dsh-llm/types'
import { defaultRecognizedSelection } from '../src/client/recognize.ts'

describe('default recognized model selection', () => {
  it('selects the latest two per family by version', () => {
    const ids = ['claude-opus-4-8', 'gpt-6-sol', 'deepseek-reasoner', 'gpt-5.5-sol', 'claude-opus-5', 'gpt-6-astra', 'deepseek-chat', 'claude-opus-5-5', 'gpt-6.1-sol']
    const selection = defaultRecognizedSelection(ids.map(id => ({ id })))
    expect([...selection.checked].sort()).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'claude-opus-5-5', 'claude-opus-5', 'deepseek-chat', 'deepseek-reasoner'].sort())
  })

  it('selects each distinct gateway family', () => {
    const ids = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini', 'gpt-image-1.5']
    expect([...defaultRecognizedSelection(ids.map(id => ({ id }))).checked].sort()).toEqual([...ids].sort())
  })

  it('selects the latest two per family by creation time before version', () => {
    const models = [{ id: 'model-3', createdAt: 1 }, { id: 'model-1', createdAt: 3 }, { id: 'model-2', createdAt: 2 }]
    expect([...defaultRecognizedSelection(models).checked]).toEqual(['model-1', 'model-2'])
  })
  it('orders distinct families by creation time when available', () => {
    const models: readonly LlmDiscoveredModel[] = [
      { id: 'old', createdAt: 1 },
      { id: 'mid', createdAt: 2 },
      { id: 'new', createdAt: 4 },
      { id: 'newer', createdAt: 3 },
    ]
    const selection = defaultRecognizedSelection(models)
    expect(selection.orderBasis).toBe('createdAt')
    expect([...selection.checked].sort()).toEqual(['mid', 'new', 'newer', 'old'])
    expect(selection.models.map(model => model.id)).toEqual(['new', 'newer', 'mid', 'old'])
  })

  it('keeps server order and notes the missing times when none are disclosed', () => {
    const models: readonly LlmDiscoveredModel[] = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
    ]
    const selection = defaultRecognizedSelection(models)
    expect(selection.orderBasis).toBe('server')
    expect([...selection.checked]).toEqual(['a', 'b', 'c', 'd'])
    expect(selection.models.map(model => model.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
