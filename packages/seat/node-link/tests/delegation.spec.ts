/** No declaration supplies a delegation on behalf of an unauthenticated caller. */
import { Context } from '@panedesk/cordis'
import { expect, expectTypeOf, test } from 'vitest'
import type { RoutedSendMessageRequest } from '@panedesk/dsh-message-delivery'
import type { NodeDelegationRequest, NodePreparedRequest, NodeWireRequest } from '../src/index.ts'
import { decodeRequest } from '../src/codec.ts'

test('keeps delegation mandatory and preserves method correlation without installing an issuer', async () => {
  expectTypeOf<NodePreparedRequest>().toExtend<NodeWireRequest>()
  expectTypeOf<Extract<NodePreparedRequest, { method: 'messages.send' }>['payload']>()
    .toEqualTypeOf<RoutedSendMessageRequest>()
  expectTypeOf<NodeDelegationRequest>().not.toHaveProperty('delegation')
  expectTypeOf<NodePreparedRequest['method']>().toEqualTypeOf<NodeWireRequest['method']>()
  const ctx = new Context()
  try {
    expect(ctx.get('nodeDelegationIssuer')).toBeUndefined()
    expect(ctx.get('nodeDelegationReceivingPolicy')).toBeUndefined()
    expect(ctx.get('nodeRouter')).toBeUndefined()
    expect(() => decodeRequest({ method: 'seat.open' })).toThrow('Node frame rejected')
  } finally { await ctx.fiber.dispose() }
})
