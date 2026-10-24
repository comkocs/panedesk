/** Missing execution never reaches the transport store or local providers. */
import { expect, expectTypeOf, test } from 'vitest'
import { OperationStore, PosixPrivateFiles, digest } from '@panedesk/dsh-host-admin'
import { NODE_LINK_VERSION } from '../src/index.ts'
import type { NodeLinkExecutionAdapter, NodeLinkExecutor } from '../src/index.ts'
import { decodeRequest } from '../src/codec.ts'
import { NodeReceiver } from '../src/receiver.ts'

test('refuses authenticated ingress when the local executor is absent', async () => {
  expectTypeOf<NodeLinkExecutionAdapter['create']>().returns.toEqualTypeOf<NodeLinkExecutor>()
  const payload = { operationId: 'operation-a', seat: 'seat-a', nodeId: 'node-b' }
  const deadline = new Date(Date.now() + 60000).toISOString()
  const request = decodeRequest({ version: NODE_LINK_VERSION, requestId: 'request-a', sourceNodeId: 'node-a',
    targetNodeId: 'node-b', operationId: 'operation-a', deadline, hop: 1, method: 'seat.wake',
    payload, payloadDigest: digest(payload), delegation: { kind: 'node-delegation', hop: 1,
      principalId: 'principal-a', authorizationRef: 'authorization-a', sourceNodeId: 'node-a',
      targetNodeId: 'node-b', operationId: 'operation-a', requestDigest: digest(payload), taskIds: [], expiresAt: deadline } })
  const files = new PosixPrivateFiles(process.cwd(), process.getuid!())
  const store = new OperationStore(files, 65536, 100)
  const receiver = new NodeReceiver('node-b', 'node-a', store, () => undefined)
  expect(await receiver.receive(request)).toMatchObject({ status: 'unavailable',
    error: { code: 'cross-node-unsupported', effectState: 'none' } })
})
