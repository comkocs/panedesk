import { describe, expect, expectTypeOf, it } from 'vitest'
import type { QueueAction } from '../src/types.ts'

describe('queue reprioritization vocabulary', () => {
  it('admits all three effective priorities without replacing existing actions', () => {
    const actions = [
      { kind: 'reprioritize', priority: 'immediate' },
      { kind: 'reprioritize', priority: 'steer' },
      { kind: 'reprioritize', priority: 'queue' },
    ] satisfies QueueAction[]
    expectTypeOf<(typeof actions)[number]>().toExtend<QueueAction>()
    expect(actions.map(action => action.priority)).toEqual(['immediate', 'steer', 'queue'])
  })
})
