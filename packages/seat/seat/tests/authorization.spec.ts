/** Trusted attribution stays separate from legacy authority strings and journal event names. */
import { Context } from '@panedesk/cordis'
import { expect, expectTypeOf, test } from 'vitest'
import { SEAT_AUTHORIZATION_EVENT_NAME, SEAT_ENGINE_EVENT_NAMES } from '../src/index.ts'
import type {
  SeatAuthorizationCheck, SeatAuthorizationGrant, SeatAuthorizationTransactions,
  SeatAuthorizedAction, SeatCallContext, SeatIssuedAuthorizationKind, PendingSeatMutationResult,
} from '../src/index.ts'

test('requires issued facts in a synchronous action builder without activating a legacy writer', async () => {
  expectTypeOf<SeatCallContext>().not.toExtend<SeatAuthorizationGrant>()
  expectTypeOf<SeatAuthorizationCheck>().not.toHaveProperty('kind')
  expectTypeOf<SeatAuthorizationCheck>().not.toHaveProperty('principalId')
  expectTypeOf<SeatAuthorizationCheck>().not.toHaveProperty('origin')
  expectTypeOf<SeatIssuedAuthorizationKind>().toEqualTypeOf<
    'model-tool-call' | 'human' | 'engine' | 'local-operator' | 'node-delegation' | 'plugin'
  >()
  expectTypeOf<SeatAuthorizationTransactions['transact']>().parameter(1).toEqualTypeOf<() => SeatAuthorizedAction>()
  expectTypeOf<SeatAuthorizationTransactions['approve']>().returns.toEqualTypeOf<Promise<PendingSeatMutationResult>>()
  expect(Object.hasOwn(SEAT_ENGINE_EVENT_NAMES, SEAT_AUTHORIZATION_EVENT_NAME)).toBe(false)
  const ctx = new Context()
  try {
    expect(ctx.get('seatAuthorizationTransactions')).toBeUndefined()
    expect(ctx.get('seatAuthorizationQueries')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
