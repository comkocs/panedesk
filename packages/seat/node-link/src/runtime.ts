/** Paired optional transport owns every listener, child, epoch and operation store. */
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import { PosixPrivateFiles, OperationStore, listenLoopback, object, identifier, digest, type LoopbackListener } from '@panedesk/dsh-host-admin'
import { NODE_LINK_VERSION, type Config } from './index.ts'
import { loadCredential } from './credentials.ts'
import { NodeReceiver } from './receiver.ts'
import { NodeRouter } from './router.ts'
import { decodeRequest } from './codec.ts'
import { SshTunnel } from './tunnel.ts'

/** Mount one explicitly configured peer; importing or mounting empty config performs no I/O.
 * @param ctx - Lifecycle and optional local execution/subprocess services.
 * @param config - Paired endpoint and resource options.
 */
export async function mountNode(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const options = config.runtime
  if (options === undefined) return () => Promise.resolve()
  if (!identifier(options.nodeId) || !identifier(options.peerNodeId) || options.nodeId === options.peerNodeId) {
    throw new Error('Node identities rejected')
  }
  const privateFiles = (directory: string) => ctx.get('nodeLinkFiles')?.(directory)
    ?? new PosixPrivateFiles(directory, process.getuid?.() ?? -1)
  const files = privateFiles(options.directory)
  const store = new OperationStore(privateFiles(join(options.directory, 'received')), options.maxStoreBytes, options.maxOperations)
  const outgoing = new OperationStore(privateFiles(join(options.directory, 'sent')), options.maxStoreBytes, options.maxOperations)
  const receiver = new NodeReceiver(options.nodeId, options.peerNodeId, store, () => ctx.get('nodeLinkExecutor'))
  let listener: LoopbackListener | undefined, tunnel: SshTunnel | undefined, router: NodeRouter | undefined
  let unlock: (() => Promise<void>) | undefined
  let stopped = false
  let probe: NodeJS.Timeout | undefined
  let probing: Promise<boolean> | undefined
  const ready = (async () => {
    await files.prepare()
    unlock = await files.lock()
    const inbound = await loadCredential(files, 'inbound', options.peerNodeId, options.nodeId)
    const outbound = await loadCredential(files, 'outbound', options.nodeId, options.peerNodeId)
    if (inbound.credential === outbound.credential) throw new Error('Directional credentials must differ')
    await store.load(); await outgoing.load()
    listener = await listenLoopback(options.listenPort, options, () => inbound, async (value) => {
      if (object(value) && value.type === 'hello') {
        if (value.version !== NODE_LINK_VERSION || value.sourceNodeId !== options.peerNodeId
          || value.targetNodeId !== options.nodeId || !identifier(value.nonce)) throw new Error('Node handshake rejected')
        const executor = ctx.get('nodeLinkExecutor')
        if (executor === undefined) throw new Error('Local node provider unavailable')
        return { version: NODE_LINK_VERSION, nodeId: options.nodeId, epoch: inbound.epoch,
          nonce: value.nonce, status: await executor.status() }
      }
      if (object(value) && value.type === 'receipt') {
        const request = decodeRequest(value.request)
        const executor = ctx.get('nodeLinkExecutor')
        if (request.sourceNodeId !== options.peerNodeId || request.targetNodeId !== options.nodeId
          || Date.parse(request.delegation.expiresAt) <= Date.now() || executor === undefined || !await executor.authorize(request)) {
          throw new Error('Receipt authority rejected')
        }
        return store.query(JSON.stringify([request.sourceNodeId, request.delegation.principalId, request.operationId]),
          digest({ method: request.method, payload: request.payload, principalId: request.delegation.principalId,
            seat: request.delegation.seat ?? null, sessionId: request.delegation.sessionId ?? null, taskIds: request.delegation.taskIds }))
      }
      return receiver.receive(decodeRequest(value))
    })
    router = new NodeRouter(options, outbound, outgoing, () => !stopped && (tunnel === undefined || tunnel.available))
    if (options.ssh !== undefined) {
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) throw new Error('Node link requires a local subprocess provider')
      tunnel = new SshTunnel(subprocess, options, listener.port, () => router?.disconnect())
      await tunnel.start()
    }
    ctx.provide('nodeRouter', router)
    await router.handshake()
    const poll = (): void => {
      if (stopped || router === undefined) return
      probing = router.handshake()
      void probing.finally(() => { if (!stopped) probe = setTimeout(poll, options.staleMs) })
    }
    probe = setTimeout(poll, options.staleMs)
  })()
  const dispose = async (): Promise<void> => {
    stopped = true
    if (probe !== undefined) clearTimeout(probe)
    await ready.catch((error: unknown) => { void error })
    if (probe !== undefined) clearTimeout(probe)
    await tunnel?.close()
    await probing
    await listener?.close()
    await store.close(); await outgoing.close()
    await unlock?.()
  }
  try { await ready }
  catch (error) { await dispose(); throw error }
  return dispose
}
