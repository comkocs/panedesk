/** Administration approval consumes the transaction owner without invoking legacy approval. */
import { expect, test, vi } from 'vitest'
import type { SeatAuthorizationGrant, SeatEngineService, SeatAuthorizationQueries, SeatAuthorizationTransactions } from '@panedesk/dsh-seat'
import { createHostAdminExecutor } from '../src/executor.ts'
import { decodeRequest } from '../src/codec.ts'
import { digest } from '../src/json.ts'
import { HOST_ADMIN_VERSION, type HostAdminAuthority } from '../src/index.ts'

const request = decodeRequest({ version: HOST_ADMIN_VERSION, requestId: 'approval-a', processEpoch: 'epoch-a',
  nonce: 'nonce-a', method: 'engine.approve', params: { operationId: 'operation-a', queueItemId: 'queue-a', expectedStateVersion: 1 } })

test('passes the exact operator grant into atomic approval and rejects delegated operator impersonation', async () => {
  const authority = { principalId: 'operator-a', authorizationRef: 'authority-a', kind: 'local-operator',
    methods: ['engine.approve'] } as HostAdminAuthority
  const grant = { fact: { authorizationId: authority.authorizationRef, kind: 'local-operator', principalId: authority.principalId,
    origin: 'manual', nodeId: 'node-a', taskIds: [], operationId: 'operation-a', policyRevision: 1,
    decision: 'allowed', reasonCode: 'allowed', requestDigest: digest(request.params), checkedAt: new Date().toISOString() } } as SeatAuthorizationGrant
  const result = { status: 'rejected' as const, error: { code: 'unavailable' as const, message: 'Test transaction refusal',
    alternative: 'Restore the transaction owner', retryable: false, effectState: 'none' as const } }
  const approve = vi.fn(async () => result)
  const authorization: SeatAuthorizationTransactions = { approve, transact: async () => result, query: async () => result }
  const legacy = vi.fn(async () => { throw new Error('Legacy approval must not run') })
  const executor = createHostAdminExecutor({ nodeId: grant.fact.nodeId, authorization,
    engine: { approve: legacy } as SeatEngineService, queries: {} as SeatAuthorizationQueries,
    policy: { authorize: async () => ({ check: async () => grant }) } })
  expect(await executor.execute(request, authority)).toMatchObject({ status: 'ok', result })
  expect(approve).toHaveBeenCalledWith(request.params, grant)
  expect(legacy).not.toHaveBeenCalled()
  const delegated = { ...grant, fact: { ...grant.fact, kind: 'node-delegation' as const } }
  const denied = createHostAdminExecutor({ nodeId: grant.fact.nodeId, authorization,
    engine: { approve: legacy } as SeatEngineService, queries: {} as SeatAuthorizationQueries,
    policy: { authorize: async () => ({ check: async () => delegated }) } })
  expect(await denied.execute(request, authority)).toMatchObject({ code: 'admin-unauthorized' })
  expect(approve).toHaveBeenCalledTimes(1)
  expect(legacy).not.toHaveBeenCalled()
})
