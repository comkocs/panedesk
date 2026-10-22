import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AgentCancelCause, ToolCancellationResult } from '../src/types.ts'

describe('explicit interjection cancellation', () => {
  it('retains the cause without claiming rollback of side effects', () => {
    const cause = { kind: 'interjection' } satisfies AgentCancelCause
    const result = { cause, outcome: 'cancelled', sideEffects: 'unknown' } satisfies ToolCancellationResult
    expectTypeOf(cause).toExtend<AgentCancelCause>()
    expect(result).toEqual({ cause: { kind: 'interjection' }, outcome: 'cancelled', sideEffects: 'unknown' })
  })
})
