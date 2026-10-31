// @vitest-environment jsdom
/**
 * Default selection for "Recognize models": the three newest advertised models
 * start checked. Models without a creation time keep server order and are
 * noted as unordered.
 */
import { describe, expect, it } from 'vitest'
import type { LlmDiscoveredModel } from '@panedesk/dsh-llm/types'
import { defaultRecognizedSelection } from '../src/client/recognize.ts'

describe('default recognized model selection', () => {
  it('checks the three newest models when creation times exist', () => {
    const models: readonly LlmDiscoveredModel[] = [
      { id: 'old', createdAt: 1 },
      { id: 'mid', createdAt: 2 },
      { id: 'new', createdAt: 4 },
      { id: 'newer', createdAt: 3 },
    ]
    const selection = defaultRecognizedSelection(models)
    expect(selection.orderBasis).toBe('createdAt')
    expect([...selection.checked]).toEqual(['new', 'newer', 'mid'])
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
    expect([...selection.checked]).toEqual(['a', 'b', 'c'])
    expect(selection.models.map(model => model.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
