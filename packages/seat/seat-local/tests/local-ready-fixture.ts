/** Real local recovery and node-link startup with deterministically late business registration. */
import { vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PosixPrivateFiles, listenLoopback, callLoopback } from '@panedesk/dsh-host-admin'
import { ChainBusinessRegistry } from '@panedesk/dsh-node-link/src/chain-business.ts'
import { mountNode } from '@panedesk/dsh-node-link/src/runtime.ts'
import type * as T from '@panedesk/dsh-seat'
import { LocalSeatService } from '../src/service.ts'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

export async function localReadyHost() {
  const h = await admissionHost()
  const recovery = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  // The replacement invokes the original with its actual receiving service below.
  // oxlint-disable-next-line typescript/unbound-method
  const recover = LocalSeatService.prototype.recover
  const recovering = vi.spyOn(LocalSeatService.prototype, 'recover').mockImplementation(async function (this: LocalSeatService) {
    entered.resolve(undefined)
    await recovery.promise
    await recover.call(this)
  })
  let closeLink: (() => Promise<void>) | undefined
  try {
    await h.reload()
    await entered.promise
    const registry = new ChainBusinessRegistry(), delayed: (() => void)[] = []
    const register = registry.register.bind(registry)
    vi.spyOn(registry, 'register').mockImplementation((provider) => {
      let dispose: (() => void) | undefined, closed = false
      delayed.push(() => { if (!closed) dispose = register(provider) })
      return () => { closed = true; dispose?.() }
    })
    const ready = vi.spyOn(registry, 'ready')
    h.ctx.provide('nodeWorkChainBusiness', registry)
    const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'] as const
    h.ctx.provide('nodeWorkChain', { maxControlPending: 2,
      local: { methods, seats: h.ctx.get('seats')!, engine: h.engine, ready: async () => {} },
      policy: { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 1000 }, ready: async () => {},
        authorize: async () => { throw new Error('No remote business authorization in this fixture') } } })
    await h.ctx.loader.await()
    const auth = () => ({ credential: randomBytes(32).toString('hex'), epoch: randomUUID() })
    const limits = { maxFrameBytes: 65536, requestTimeoutMs: 100, maxPending: 2,
      maxStoreBytes: 65536, maxOperations: 20, staleMs: 50 }
    const inbound = auth(), outbound = auth()
    const reserve = await listenLoopback(0, limits, auth, async () => ({}))
    const listenPort = reserve.port
    await reserve.close()
    const peer = await listenLoopback(0, limits, auth, async () => ({}))
    const peerPort = peer.port
    await peer.close()
    const directory = join(h.options.directory, 'offline-node-link')
    const files = new PosixPrivateFiles(directory, process.getuid!())
    await files.write('inbound.json', JSON.stringify({ ...inbound, sourceNodeId: 'offline-peer', targetNodeId: h.options.nodeId }))
    await files.write('outbound.json', JSON.stringify({ ...outbound, sourceNodeId: h.options.nodeId, targetNodeId: 'offline-peer' }))
    h.ctx.provide('nodeLinkExecutor', { authorize: async () => false,
      execute: async () => { throw new Error('No legacy remote writes in this fixture') },
      status: () => h.engine.nodeStatus() })
    closeLink = await mountNode(h.ctx, { runtime: { ...limits, directory, nodeId: h.options.nodeId,
      peerNodeId: 'offline-peer', peerName: 'offline-peer', listenPort, peerPort } })
    for (const install of delayed) install()
    const providers = methods.map(method => registry.resolve(method)!)
    const providerReady = providers.map(provider => vi.spyOn(provider, 'ready'))
    const seats = h.ctx.get('seats')!.withAuthority(h.authority)
    const other = { ...h.definition, seat: 'seat-b' as T.SeatName }
    const catalog = await seats.definitions({})
    await seats.save({ definition: other, expectedRevision: catalog.revision, operationId: operation('save-local-b') })
    const tasks = [h.definition, other].map((definition, index): T.SeatTaskScopeContext => {
      const taskId = `task-${index}` as T.SeatTaskId
      return { taskId, seat: definition.seat, nodeId: h.options.nodeId,
        scopeEvidenceRef: `scope-${index}` as T.SeatTaskScopeContext['scopeEvidenceRef'],
        scopeEvidence: { status: 'known', taskId, revision: '1', repositoryId: 'repo' as T.TaskRepositoryId,
          baseRevision: 'base', entries: [{ kind: 'file', path: `${index}.ts`, access: 'write' }],
          patternSyntax: 'literal', caseSensitive: true } }
    })
    const contexts = h.ctx.get('seatOpeningContexts')!
    const unregisterScope = contexts.registerScopeAdmission!({
      evaluateTaskScopes: async () => ({ outcome: 'allow', revisions: tasks.map(task => ({ taskId: task.taskId, revision: '1' })) }),
      batch: (_request, _authority, execute) => execute(), open: (_request, _authority, execute) => execute() })
    const batch = () => contexts.openBatch({ seats: tasks.map(task => task.seat), tasks, origin: 'manual',
      openingMode: 'prefill', operationId: operation('offline-disjoint') }, h.authority)
    return { h, registry, ready, providerReady, recovery, batch,
      local: h.ctx.get('seats') as LocalSeatService,
      hello: () => callLoopback(listenPort, inbound, { type: 'hello', version: 'node-link/v1',
        sourceNodeId: 'offline-peer', targetNodeId: h.options.nodeId, nonce: 'late-hello',
        chain: { capability: 'node-work-chain/v1', maxFrameBytes: limits.maxFrameBytes,
          methods: [...methods, 'chain.operation'] } }, limits),
      async close() {
        recovery.resolve(undefined); recovering.mockRestore()
        await unregisterScope(); await closeLink?.(); await h.close()
      } }
  } catch (error) {
    recovery.resolve(undefined); recovering.mockRestore()
    await closeLink?.(); await h.close()
    throw error
  }
}
