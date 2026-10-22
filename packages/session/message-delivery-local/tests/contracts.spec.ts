import { expect, it } from 'vitest'
import { apply, name } from '../src/index.ts'

it('exports an inactive local provider entry', () => {
  expect(name).toBe('message-delivery-local')
  expect(apply).not.toThrow()
})
