/** Sender deadlines include evidence and intent publication without withdrawing a healthy connection. */
import { expect, test, vi } from 'vitest'
import * as Host from '@panedesk/dsh-host-admin'
import type * as Seat from '@panedesk/dsh-seat'
import { ChainRouter } from '../src/chain-router.ts'
import { ChainRetainedEvidence } from '../src/chain-retained.ts'
import { ChainStore } from '../src/chain-store.ts'
import { chainDigest, decodeChainRequest } from '../src/chain-codec.ts'
import { chainKey } from '../src/chain-identity.ts'
import type { ChainCapability } from '../src/chain-types.ts'
import { networkInput } from './chain-network-fixture.ts'

test.each(['evidence-query', 'evidence-delegation', 'intent'] as const)(
  'does not dispatch or disconnect when %s publication exhausts the sending deadline', async (stage) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = Date.now(), deadline = new Date(now + 1000).toISOString()
    const input = networkInput('deadline-a', deadline)
    const original = decodeChainRequest(input.request)
    const payload = { key: chainKey(original), payloadDigest: original.payloadDigest }
    const request = stage === 'evidence-query' ? decodeChainRequest({ ...original, method: 'chain.operation', payload,
      payloadDigest: chainDigest('chain.operation', payload), delegation: { ...original.delegation,
        requestDigest: chainDigest('chain.operation', payload) } }) : decodeChainRequest({ ...original,
      deadline: stage === 'evidence-delegation' ? new Date(now + 2000).toISOString() : deadline })
    const fact: Seat.SeatIssuedAuthorizationFact = { ...input.fact, kind: 'human', origin: 'manual', decision: 'allowed',
      reasonCode: 'allowed', nodeId: request.sourceNodeId, authorizationId: request.delegation.authorizationRef,
      principalId: request.delegation.principalId, operationId: request.operationId,
      requestDigest: request.payloadDigest, taskIds: request.delegation.taskIds }
    const grant = { fact } as Pick<Seat.SeatAuthorizationGrant, 'fact'> as Seat.SeatAuthorizationGrant
    const records = new Map<string, string>()
    const files: Host.PrivateFiles = { prepare: async () => {}, read: async name => records.get(name) ?? null,
      write: async (name, content) => {
        records.set(name, content)
        if (name === (stage === 'intent' ? 'chain-v1.json' : 'evidence-v1.json')) vi.setSystemTime(now + 1001)
      }, remove: async (name) => { records.delete(name) }, lock: async () => async () => {} }
    const store = new ChainStore(files, 65536, 10)
    const evidence = new ChainRetainedEvidence(files, 65536, 10, 'node-a', 'node-b')
    const capability: ChainCapability = { capability: 'node-work-chain/v1', maxFrameBytes: 65536,
      methods: ['source.prepareOpening', 'chain.operation'] }
    let connected = true
    const disconnect = vi.fn(() => { connected = false })
    const wire = vi.spyOn(Host, 'callLoopback').mockRejectedValue(new Host.LoopbackConnectionError('Unexpected dispatch'))
    const router = new ChainRouter({ directory: '.', nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer',
      listenPort: 0, peerPort: 1, maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 2,
      maxStoreBytes: 65536, maxOperations: 10, staleMs: 10 }, store,
    () => ({ sourceNodeId: 'node-a', targetNodeId: 'node-b', epoch: 'test', credential: 'unused' }), () => connected,
    () => ({ local: capability, remote: capability }), evidence, disconnect)
    try {
      await store.load()
      const response = await router.route(request, grant)
      expect(response).toMatchObject({ status: 'unavailable', error: { code: 'node-deadline-exceeded',
        effectState: 'none', cause: { reasonCode: 'deadline-exceeded' } } })
      expect(wire).not.toHaveBeenCalled()
      expect(disconnect).not.toHaveBeenCalled()
      expect(connected).toBe(true)
      expect(store.pending()).toEqual(stage === 'evidence-query' ? [] : [request])
      if (stage !== 'evidence-query') {
        expect(store.query(chainKey(request), request.payloadDigest)).toEqual({ state: 'settled', response })
        const restored = new ChainStore(files, 65536, 10)
        await restored.load()
        expect(restored.query(chainKey(request), request.payloadDigest)).toEqual({ state: 'settled', response })
        expect(restored.pending()).toEqual([request])
        await restored.close()
      }
    } finally {
      await router.close(); await store.close(); await evidence.close()
      wire.mockRestore(); vi.useRealTimers()
    }
  })
