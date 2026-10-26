/** Recovery faults cannot advertise an unverified evidence store or discard pending original intents. */
import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PosixPrivateFiles } from '@panedesk/dsh-host-admin'
import type * as Seat from '@panedesk/dsh-seat'
import { ChainRuntime } from '../src/chain-runtime.ts'
import { ChainBusinessRegistry } from '../src/chain-business.ts'
import { ChainRetainedEvidence } from '../src/chain-retained.ts'
import { ChainStore } from '../src/chain-store.ts'
import { decodeChainRequest } from '../src/chain-codec.ts'
import { helloAdvertisement } from '../src/chain-hello.ts'
import { networkInput } from './chain-network-fixture.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chain-recovery-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const files = (directory: string) => new PosixPrivateFiles(directory, process.getuid!())
  const options = { directory: root, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer', listenPort: 0,
    peerPort: 1, maxFrameBytes: 65536, requestTimeoutMs: 100, maxPending: 2, maxStoreBytes: 65536, maxOperations: 10, staleMs: 10 }
  const input = networkInput('recover-a', new Date(Date.now() + 30000).toISOString())
  const request = decodeChainRequest(input.request)
  const fact: Seat.SeatIssuedAuthorizationFact = { ...input.fact, kind: 'human', origin: 'manual', decision: 'allowed',
    reasonCode: 'allowed', nodeId: request.sourceNodeId, authorizationId: request.delegation.authorizationRef,
    principalId: request.delegation.principalId, operationId: request.operationId,
    requestDigest: request.payloadDigest, taskIds: request.delegation.taskIds }
  const grant = { fact } as Pick<Seat.SeatAuthorizationGrant, 'fact'> as Seat.SeatAuthorizationGrant
  const retained = new ChainRetainedEvidence(files(join(root, 'chain-evidence')), 65536, 10, 'node-a', 'node-b')
  await retained.retain(request, grant); await retained.close()
  const store = new ChainStore(files(join(root, 'chain-sent')), 65536, 10)
  await store.load(); await store.admit(request); await store.close()
  const business = new ChainBusinessRegistry()
  business.register({ methods: ['source.prepareOpening'], ready: async () => {}, query: async () => ({ status: 'missing' }) })
  const issuer = vi.fn(async () => undefined)
  const create = () => {
    const runtime = new ChainRuntime(options, {
      maxControlPending: 1, policy: { ready: async () => {}, expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
        authorize: async () => { throw new Error('Unexpected receiving execution') } },
      local: { methods: ['source.prepareOpening'], ready: async () => {} }, outboxIssuer: issuer,
    }, business, files, () => { throw new Error('Unexpected network dispatch') }, () => true, () => true)
    cleanups.push(() => runtime.close())
    return runtime
  }
  const pending = async () => {
    const restored = new ChainStore(files(join(root, 'chain-sent')), 65536, 10)
    await restored.load()
    expect(restored.pending()).toEqual([request])
    await restored.close()
  }
  return { root, files, create, pending, request, issuer }
}

test('without a local revision provider the complete legacy seven-method advertisement is unchanged', async () => {
  const f = await fixture(), business = new ChainBusinessRegistry()
  const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen', 'source.prepareOpening',
    'source.checkAdmission', 'source.deliverCallback'] as const
  business.register({ methods, ready: async () => {}, query: async () => ({ status: 'missing' }) })
  await f.files(join(f.root, 'legacy')).prepare()
  const runtime = new ChainRuntime({ directory: join(f.root, 'legacy'), nodeId: 'node-a', peerNodeId: 'node-b',
    peerName: 'peer', listenPort: 0, peerPort: 1, maxFrameBytes: 65536, requestTimeoutMs: 100,
    maxPending: 2, maxStoreBytes: 65536, maxOperations: 10, staleMs: 10 }, {
    maxControlPending: 1, policy: { ready: async () => {}, expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
      authorize: async () => { throw new Error('Unexpected receiving execution') } },
    local: { methods: [...methods, 'seat.definitionRevision'], ready: async () => {} },
  }, business, f.files, () => { throw new Error('Unexpected network dispatch') }, () => true, () => true)
  cleanups.push(() => runtime.close())
  await runtime.ready()
  expect(JSON.stringify(helloAdvertisement(runtime.capability()))).toBe(JSON.stringify({ chain: {
    capability: 'node-work-chain/v1', maxFrameBytes: 65536, methods: [...methods, 'chain.operation'],
  } }))
  expect(helloAdvertisement(undefined)).toEqual({})
})

test.each(['malformed-json', 'wrong-identity'] as const)('evidence recovery refuses %s without advertising or replaying pending work', async (fault) => {
  const f = await fixture(), files = f.files(join(f.root, 'chain-evidence'))
  const original = (await files.read('evidence-v1.json', 65536))!
  const corrupted = fault === 'malformed-json' ? '{' : original.replaceAll('node-a', 'other-node')
  await files.write('evidence-v1.json', corrupted)
  const runtime = f.create()
  await expect(runtime.ready()).rejects.toThrow()
  expect(runtime.capability()).toBeUndefined()
  runtime.observe({ capability: 'node-work-chain/v1', maxFrameBytes: 65536, methods: ['chain.operation'] })
  expect(f.issuer).not.toHaveBeenCalled()
  await runtime.close()
  expect(await files.read('evidence-v1.json', 65536)).toBe(corrupted)
  await f.pending()
  await files.write('evidence-v1.json', original)
  const repaired = f.create()
  await repaired.ready()
  expect(repaired.capability()).toBeDefined()
  await f.pending()
})

test('expired evidence is removed on recovery while the original unresolved intent survives without fresh outbox authority', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 40000)
  const runtime = f.create()
  await runtime.ready()
  expect(runtime.capability()).toBeDefined()
  expect(await f.files(join(f.root, 'chain-evidence')).read('evidence-v1.json', 65536))
    .toBe('{"version":"node-work-chain-evidence/v1","entries":{}}')
  runtime.observe({ capability: 'node-work-chain/v1', maxFrameBytes: 65536, methods: ['chain.operation'] })
  await runtime.close()
  expect(f.issuer).toHaveBeenCalledWith(f.request)
  await f.pending()
})

test('interrupted expiry publication keeps pending work and the last evidence generation for a fresh recovery', async () => {
  const f = await fixture(), files = f.files(join(f.root, 'chain-evidence'))
  const original = await files.read('evidence-v1.json', 65536)
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 40000)
  const publication = vi.spyOn(PosixPrivateFiles.prototype, 'write').mockRejectedValueOnce(new Error('Interrupted recovery publication'))
  const interrupted = f.create()
  await expect(interrupted.ready()).rejects.toThrow('Interrupted recovery publication')
  expect(interrupted.capability()).toBeUndefined()
  await interrupted.close()
  publication.mockRestore()
  expect(await files.read('evidence-v1.json', 65536)).toBe(original)
  await f.pending()
  const restarted = f.create()
  await restarted.ready()
  expect(restarted.capability()).toBeDefined()
  expect(await files.read('evidence-v1.json', 65536)).toBe('{"version":"node-work-chain-evidence/v1","entries":{}}')
  await f.pending()
})
