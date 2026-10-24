/** Remote forwarding preserves original operation identity and unknown-effect semantics. */
import { Context } from '@panedesk/cordis'
import { expect, test } from 'vitest'
import type * as Seat from '@panedesk/dsh-seat'
import { failure } from '@panedesk/dsh-node-link/src/receiver.ts'
import { routeSeat } from '../src/node-routing.ts'

const source = 'node-a' as Seat.SeatNodeId, target = 'node-b' as Seat.SeatNodeId
const operationId = 'operation-a' as Seat.SeatOperationId
const authority: Seat.SeatCallContext = { principalId: 'principal-a' as Seat.SeatPrincipalId, origin: 'manual', nodeId: source }
const payload: Seat.WakeSeatRequest = { operationId, seat: 'seat-a' as Seat.SeatName, nodeId: target }

test('keeps legacy dispatch when routing is absent and preserves unknown after an unresolved remote send', async () => {
  const ctx = new Context()
  try {
    expect(await routeSeat(ctx, source, target, authority, 'seat.wake', payload)).toBeUndefined()
    ctx.provide('nodeDelegationIssuer', { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 }, issue: async request => ({
      status: 'issued', delegation: { kind: 'node-delegation', hop: 1, principalId: authority.principalId,
        authorizationRef: 'authorization-a' as Seat.AuthorizationRef, sourceNodeId: source, targetNodeId: target,
        operationId, requestDigest: request.payloadDigest, taskIds: [], expiresAt: request.deadline } }) })
    let calls = 0
    ctx.provide('nodeRouter', { status: async () => [], route: async (request) => {
      calls++
      expect(request.operationId).toBe(operationId)
      expect(request.payload).toEqual(payload)
      return failure(request, 'node-outcome-unknown', true)
    } })
    expect(await routeSeat(ctx, source, target, authority, 'seat.wake', payload))
      .toMatchObject({ status: 'rejected', error: { effectState: 'unknown' } })
    const delegated = { ...authority, authorization: { fact: { kind: 'node-delegation' } } as Seat.SeatAuthorizationGrant }
    expect(await routeSeat(ctx, source, target, delegated, 'seat.wake', payload))
      .toMatchObject({ status: 'rejected', error: { code: 'unauthorized', effectState: 'none' } })
    expect(calls).toBe(1)
  } finally { await ctx.fiber.dispose() }
})
