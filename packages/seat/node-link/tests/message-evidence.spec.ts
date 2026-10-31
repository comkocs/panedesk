/** Independent evidence admits only the configured peer and drains through reserved control slots. */
import { expect, it } from 'vitest'
import { digest } from '@panedesk/dsh-host-admin'
import { MessageEvidenceChannel } from '../src/message-evidence.ts'
import { decodeRequest } from '../src/codec.ts'

it('rejects unrelated frames and keeps evidence capacity bounded', async () => {
  const options = { nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer', directory: '/unused', listenPort: 0,
    peerPort: 1, maxFrameBytes: 65536, requestTimeoutMs: 100, maxPending: 1, maxStoreBytes: 1048576, maxOperations: 10, staleMs: 100 }
  const pending = Promise.withResolvers<unknown>(), peers: string[] = []
  const channel = new MessageEvidenceChannel(options, () => ({ credential: 'unused', epoch: 'epoch',
    sourceNodeId: 'node-a', targetNodeId: 'node-b' }), () => ({ query: async (_request, peer) => {
    peers.push(peer.sourceNodeId); return pending.promise
  } }), () => false)
  const payload = { operationId: 'operation' }, expiresAt = new Date(Date.now() + 10000).toISOString()
  const request = decodeRequest({ version: 'node-link/v1', requestId: 'request', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId: 'operation', deadline: expiresAt, hop: 1, method: 'messages.onlineSeats', payload, payloadDigest: digest(payload),
    delegation: { kind: 'node-delegation', hop: 1, principalId: 'principal', authorizationRef: 'reference',
      sourceNodeId: 'node-a', targetNodeId: 'node-b', operationId: 'operation', requestDigest: digest(payload), taskIds: [], expiresAt } })
  const frame = { type: 'message-delegation-evidence', version: 'node-link/v1', requestId: 'control', request }
  await expect(channel.query(request)).rejects.toThrow('unavailable')
  await expect(channel.receive({ ...frame, extra: true })).rejects.toThrow('rejected')
  const first = channel.receive(frame)
  await expect(channel.receive(frame)).rejects.toThrow('rejected')
  pending.resolve(null)
  await expect(first).resolves.toEqual({ type: frame.type, version: frame.version, requestId: frame.requestId, evidence: null })
  expect(peers).toEqual(['node-b'])
  await expect(channel.receive(frame)).resolves.toMatchObject({ evidence: null })
})
