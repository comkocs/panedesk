/** Test-only process owns its private chain store; no evidence map crosses processes. */
import { createInterface } from 'node:readline'
import { PosixPrivateFiles } from '@panedesk/dsh-host-admin'
import { ChainStore } from '../src/chain-store.ts'
import { chainDigest, decodeChainRequest } from '../src/chain-codec.ts'
import { chainFailure, chainKey } from '../src/chain-identity.ts'

async function main(): Promise<void> {
  const directory = process.argv[2]
  if (!directory) throw new Error('Test directory required')
  const store = new ChainStore(new PosixPrivateFiles(directory, process.getuid!()), 65536, 10)
  await store.load()
  const payload = { sourceId: 'source-a', sourceOwnerNodeId: 'node-b', ownerEpoch: 'owner-a',
    reference: { providerId: 'provider-a', reference: 'opening-a', revision: '1' }, seat: 'seat-a', taskIds: ['task-a'],
    operationId: 'operation-a', targetNodeId: 'node-a', expectedSeatRevision: 1, openingMode: 'prefill' }
  const request = decodeChainRequest({ version: 'node-link/v1', requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId: 'operation-a', deadline: '2099-01-01T00:00:00.000Z', hop: 1, method: 'source.prepareOpening', payload,
    payloadDigest: chainDigest('source.prepareOpening', payload), delegation: { kind: 'node-delegation', hop: 1,
      principalId: 'principal-a', authorizationRef: 'grant-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
      operationId: 'operation-a', requestDigest: chainDigest('source.prepareOpening', payload), taskIds: ['task-a'],
      expiresAt: '2099-01-01T00:00:00.000Z' } })
  const lines = createInterface({ input: process.stdin })
  process.stdout.write('ready\n')
  for await (const command of lines) {
    if (command === 'close') break
    if (command === 'admit') process.stdout.write(`${JSON.stringify(await store.admit(request))}\n`)
    else if (command === 'query') process.stdout.write(`${JSON.stringify(store.query(chainKey(request), request.payloadDigest))}\n`)
    else if (command === 'settle') {
      await store.settle(request, chainFailure(request, 'cross-node-unsupported', 'method-not-allowed'))
      process.stdout.write('settled\n')
    } else throw new Error('Test command rejected')
  }
  lines.close()
  await store.close()
}
void main().catch((error: unknown) => { void error; process.stderr.write('Chain worker failed\n'); process.exitCode = 1 })
