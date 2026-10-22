import { describe, expect, expectTypeOf, it } from 'vitest'
import { MessageDelivery } from '../src/index.ts'
import type { ControlResult, MessageClassification, MessagePriority, SendBatchRequest, SendMessageResult } from '../src/types.ts'

describe('message delivery declarations', () => {
  it('keeps delivery refusal distinct from queued lifecycle state', () => {
    type Pending = Extract<SendMessageResult, { reason: 'target-closed-pending' }>
    expectTypeOf<Pending['messageState']>().toEqualTypeOf<'queued'>()
    expectTypeOf<Pending['pending']>().toEqualTypeOf<true>()
    expectTypeOf<Extract<ControlResult, { kind: 'accepted-pending-owner' }>['state']>().toEqualTypeOf<'queued'>()
    expect(MessageDelivery.name).toBe('MessageDelivery')
  })

  it('preserves reply classification in single and batch inputs', () => {
    expectTypeOf<SendBatchRequest>().toExtend<MessageClassification>()
    const priorities = ['immediate', 'steer', 'queue'] satisfies MessagePriority[]
    expect(priorities).toHaveLength(3)
  })
})
