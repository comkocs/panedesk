/** Identity-bearing ingress is opt-in and does not change ordinary sender authority. */
import { Context } from '@panedesk/cordis'
import { expect, expectTypeOf, test } from 'vitest'
import { MessageDelivery } from '../src/index.ts'
import type {
  DeliveryMessage, RoutedDeliveryEnvelope, RoutedMessageReceiver, RoutedSendMessageRequest,
  SendMessageRequest, SendMessageResult,
} from '../src/index.ts'

test('retains frozen delivery identity without installing a receiver or widening send', async () => {
  expectTypeOf<RoutedDeliveryEnvelope['message']>().toEqualTypeOf<DeliveryMessage>()
  expectTypeOf<RoutedSendMessageRequest>().toExtend<SendMessageRequest>()
  expectTypeOf<SendMessageRequest>().not.toExtend<RoutedSendMessageRequest>()
  expectTypeOf<MessageDelivery['send']>().parameter(0).toEqualTypeOf<SendMessageRequest>()
  expectTypeOf<RoutedMessageReceiver['receive']>().returns.toEqualTypeOf<Promise<SendMessageResult>>()
  expectTypeOf<RoutedDeliveryEnvelope>().toHaveProperty('deliveryId')
  expectTypeOf<RoutedDeliveryEnvelope>().toHaveProperty('callId')
  expectTypeOf<RoutedDeliveryEnvelope>().toHaveProperty('rootCallId')
  expectTypeOf<RoutedDeliveryEnvelope>().toHaveProperty('causedByDeliveryId')
  const ctx = new Context()
  try {
    expect(ctx.get('routedMessageReceiver')).toBeUndefined()
    expect(MessageDelivery.prototype).not.toHaveProperty('receive')
  } finally { await ctx.fiber.dispose() }
})
