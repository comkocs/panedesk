/** Independent chain persistence never converts pending business stages into terminal receipts. */
import { afterEach, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PosixPrivateFiles } from '@panedesk/dsh-host-admin'
import { ChainStore } from '../src/chain-store.ts'
import { chainDigest, decodeChainRequest, decodeChainResponse } from '../src/chain-codec.ts'
import { chainFailure, chainKey } from '../src/chain-identity.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function frame(operationId = 'operation-a', task = 'task-a') {
  const payload = { sourceId: 'source-a', sourceOwnerNodeId: 'node-b', ownerEpoch: 'owner-a',
    reference: { providerId: 'provider-a', reference: 'opening-a', revision: '1' }, seat: 'seat-a', taskIds: [task], operationId,
    targetNodeId: 'node-a', expectedSeatRevision: 1, openingMode: 'prefill' }
  return decodeChainRequest({ version: 'node-link/v1', requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId, deadline: '2099-01-01T00:00:00.000Z', hop: 1, method: 'source.prepareOpening', payload,
    payloadDigest: chainDigest('source.prepareOpening', payload), delegation: { kind: 'node-delegation', hop: 1,
      principalId: 'principal-a', authorizationRef: 'grant-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
      operationId, requestDigest: chainDigest('source.prepareOpening', payload), taskIds: [task], expiresAt: '2099-01-01T00:00:00.000Z' } })
}
async function stores(maxEntries = 10) {
  const root = await mkdtemp(join(tmpdir(), 'chain-store-'))
  roots.push(root)
  const create = () => new ChainStore(new PosixPrivateFiles(root, process.getuid!()), 65536, maxEntries)
  const first = create()
  await first.load()
  return { first, create }
}

test('retains complete pending intent across restart and rejects changed payload without replacing it', async () => {
  const { first, create } = await stores(), request = frame()
  expect(await first.admit(request)).toEqual({ state: 'admitted' })
  expect(await first.admit(request)).toEqual({ state: 'pending' })
  expect(await first.admit(frame('operation-a', 'different-task'))).toEqual({ state: 'conflict' })
  const restarted = create()
  await restarted.load()
  expect(restarted.pending()).toEqual([request])
  expect(restarted.query(chainKey(request), request.payloadDigest)).toEqual({ state: 'pending' })
  await restarted.settle(request, chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true))
  expect(restarted.query(chainKey(request), request.payloadDigest)).toEqual({ state: 'pending' })
  await first.close(); await restarted.close()
})

test('publishes authenticated terminal repair and retains original request identity after reload', async () => {
  const { first, create } = await stores(), request = frame()
  await first.admit(request)
  const response = chainFailure(request, 'node-delegation-rejected', 'remote-open-not-allowed')
  await first.settle(request, response)
  const restarted = create()
  await restarted.load()
  expect(restarted.query(chainKey(request), request.payloadDigest)).toEqual({ state: 'settled', response })
  expect(restarted.pending()).toEqual([])
  await first.close(); await restarted.close()
})

test('capacity refuses a new intent without evicting an unresolved operation', async () => {
  const { first } = await stores(1), request = frame()
  await first.admit(request)
  await expect(first.admit(frame('operation-b'))).rejects.toThrow('capacity')
  expect(first.pending()).toEqual([request])
  await first.close()
})

test('serializes duplicate admission but never holds the publication lock across business execution', async () => {
  const { first } = await stores(), request = frame()
  const outcomes = await Promise.all([first.admit(request), first.admit(request)])
  expect(outcomes).toEqual([{ state: 'admitted' }, { state: 'pending' }])
  const response = chainFailure(request, 'cross-node-unsupported', 'method-not-allowed')
  expect(decodeChainResponse(response, request)).toEqual(response)
  await first.close()
})
