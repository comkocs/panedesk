/** Administration approval delegates directly to the running engine. */
import { expect, test, vi } from 'vitest'
import type { SeatEngineService, SeatNodeId } from '@panedesk/dsh-seat'
import { createHostAdminExecutor } from '../src/executor.ts'
import { decodeRequest } from '../src/codec.ts'
import { HOST_ADMIN_VERSION, type HostAdminAuthority } from '../src/index.ts'

const request = decodeRequest({ version: HOST_ADMIN_VERSION, requestId: 'approval-a', processEpoch: 'epoch-a',
  nonce: 'nonce-a', method: 'engine.approve', params: { operationId: 'operation-a', queueItemId: 'queue-a', expectedStateVersion: 1 } })

test('passes the original approval request to the engine', async () => {
  const authority: HostAdminAuthority = { principalId: 'operator-a' as HostAdminAuthority['principalId'],
    authorizationRef: 'authority-a' as HostAdminAuthority['authorizationRef'], kind: 'local-operator', methods: ['engine.approve'] }
  const result = { status: 'approved' as const, queueItemId: 'queue-a' as Extract<typeof request, { method: 'engine.approve' }>['params']['queueItemId'], stateVersion: 2 }
  const approve = vi.fn(async () => result)
  const executor = createHostAdminExecutor({ nodeId: 'node-a' as SeatNodeId,
    engine: { approve } as Pick<SeatEngineService, 'approve'> as SeatEngineService })
  expect(await executor.execute(request, authority)).toMatchObject({ status: 'ok', result })
  expect(approve).toHaveBeenCalledWith(request.params)
})
