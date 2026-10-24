/** Trusted issuers retain exact evidence while receiving policy only narrows permissions. */
import { expect, test } from 'vitest'
import type { SeatAuthorizationGrant, SeatAuthorizationIssuer } from '@panedesk/dsh-seat'
import { digest } from '@panedesk/dsh-host-admin'
import { createDelegationIssuer, createDelegationReceivingPolicy, type DelegationEvidence } from '../src/delegation-policy.ts'
import { decodeRequest } from '../src/codec.ts'
import { NODE_LINK_VERSION } from '../src/index.ts'

function request() {
  const payload = { operationId: 'operation-a', seat: 'seat-a', nodeId: 'node-b' }
  const deadline = new Date(Date.now() + 60000).toISOString()
  return decodeRequest({ version: NODE_LINK_VERSION, requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId: payload.operationId, deadline, hop: 1, method: 'seat.wake', payload, payloadDigest: digest(payload),
    delegation: { kind: 'node-delegation', hop: 1, principalId: 'principal-a', authorizationRef: 'authorization-a',
      sourceNodeId: 'node-a', targetNodeId: 'node-b', operationId: payload.operationId,
      requestDigest: digest(payload), taskIds: [], expiresAt: deadline } })
}

test('limits expiry, checks retained evidence and rejects widened methods or mismatched peer identity', async () => {
  const frame = request(), { delegation: _delegation, ...prepared } = frame
  const expiry = { maxLifetimeMs: 60000, maxClockSkewMs: 0 }
  let evidence: DelegationEvidence | null = null
  // The authorization owner is a double; these tests do not establish journal integration.
  const grant = { fact: { authorizationId: frame.delegation.authorizationRef, kind: 'human', principalId: frame.delegation.principalId,
    origin: 'manual', nodeId: frame.sourceNodeId, taskIds: [], operationId: frame.operationId, policyRevision: 1,
    decision: 'allowed', reasonCode: 'allowed', requestDigest: frame.payloadDigest, checkedAt: new Date().toISOString() } } as SeatAuthorizationGrant
  const issuer: SeatAuthorizationIssuer = { check: async () => grant }
  const authorityExpiresAt = new Date(Date.now() + 30000).toISOString()
  const entry = createDelegationIssuer({ issuer, expiry, sourceNodeId: frame.sourceNodeId, methods: ['seat.wake'],
    authorityExpiresAt, retain: async (value) => { evidence = value } })
  const issued = await entry.issue(prepared)
  expect(issued.status).toBe('issued')
  if (issued.status !== 'issued') throw new Error('Expected issued delegation')
  expect(Date.parse(issued.delegation.expiresAt)).toBeLessThanOrEqual(Date.parse(authorityExpiresAt))
  const input = { ...prepared, delegation: issued.delegation }
  const peer = { sourceNodeId: frame.sourceNodeId, targetNodeId: frame.targetNodeId, authenticatedAt: new Date().toISOString() }
  const permission = { sourceNodeId: frame.sourceNodeId, targetNodeId: frame.targetNodeId,
    methods: ['seat.wake'] as const, policyRevision: 2 }
  const receiving = createDelegationReceivingPolicy({ expiry, permissions: [permission], evidence: async () => evidence,
    issuer: async () => issuer })
  expect(await receiving.authorize(input, peer)).toBe(issuer)
  expect(await receiving.authorize(input, { ...peer, sourceNodeId: frame.targetNodeId })).toHaveProperty('code', 'node-delegation-rejected')
  expect(await receiving.authorize({ ...input, delegation: { ...input.delegation, principalId: 'other-principal' as typeof frame.delegation.principalId } }, peer))
    .toHaveProperty('code', 'node-delegation-rejected')
  const narrowed = createDelegationReceivingPolicy({ expiry, permissions: [{ ...permission, methods: [] }],
    evidence: async () => evidence, issuer: async () => issuer })
  expect(await narrowed.authorize(input, peer)).toHaveProperty('code', 'node-delegation-rejected')
  expect(await receiving.authorize({ ...input, delegation: { ...input.delegation,
    expiresAt: new Date(Date.now() - 1).toISOString() } }, peer)).toHaveProperty('code', 'node-delegation-rejected')
  evidence = null
  expect(await receiving.authorize(input, peer)).toHaveProperty('code', 'node-delegation-rejected')
  expect(await entry.issue({ ...prepared, payloadDigest: 'different' as typeof frame.payloadDigest })).toHaveProperty('status', 'rejected')
})
