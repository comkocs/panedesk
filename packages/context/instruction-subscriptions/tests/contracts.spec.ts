import { expect, it } from 'vitest'
import { apply, name } from '../src/index.ts'

it('exports an inactive instruction subscription entry', () => {
  expect(name).toBe('instruction-subscriptions')
  expect(apply).not.toThrow()
})
