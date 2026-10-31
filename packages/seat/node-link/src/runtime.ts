/** Paired optional transport owns every listener, child, epoch and operation store. */
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import { PosixPrivateFiles, waitForPrivateFiles, PrivateFilesWaitCancelled, isPrivateFilesContextActive, OperationStore, listenAuthenticatedLoopback, object, identifier, digest, type LoopbackListener } from '@panedesk/dsh-host-admin'
import { NODE_LINK_VERSION, type Config } from './index.ts'
import { drainRuntime, onRuntimeTermination } from '@panedesk/dsh-host-admin'
import { loadCredential } from './credentials.ts'
import { NodeReceiver } from './receiver.ts'
import { NodeRouter } from './router.ts'
import { decodeRequest } from './codec.ts'
import { SshTunnel } from './tunnel.ts'
import { createNodeLinkExecutor } from './executor.ts'
import { ChainRuntime } from './chain-runtime.ts'
import { ChainBusinessRegistry } from './chain-business.ts'
import { decodeChainRequest, encodeChainFrame, isChainMethod } from './chain-codec.ts'
import { helloCapability, helloRefusal, helloAdvertisement } from './chain-hello.ts'
import { MessageEvidenceChannel } from './message-evidence.ts'
import { ChainSlots } from './chain-slots.ts'

/** Mount one explicitly configured peer; importing or mounting empty config performs no I/O.
 * @param ctx - Lifecycle and optional local execution/subprocess services.
 * @param config - Paired endpoint and resource options.
 * @param windows - Captured platform selection for deferred attachment startup.
 * @returns Disposer after accepted requests and owned resources have drained.
 */
export async function mountNode(ctx: Context, config: Config, windows = process.platform === 'win32'): Promise<() => Promise<void>> {
  const options = config.runtime
  if (options === undefined) return () => Promise.resolve()
  if (!identifier(options.nodeId) || !identifier(options.peerNodeId) || options.nodeId === options.peerNodeId) {
    throw new Error('Node identities rejected')
  }
  const inactive = () => windows && !isPrivateFilesContextActive(ctx)
  const windowsFactory = windows
    ? await waitForPrivateFiles(ctx, 'nodeLinkFiles', options.requestTimeoutMs, () => ctx.get('nodeLinkFiles')).catch((error: unknown) => {
      if (error instanceof PrivateFilesWaitCancelled) return undefined
      throw error
    }) : undefined
  if (inactive()) return async () => {}
  const privateFiles = windowsFactory ?? ((directory: string) => ctx.get('nodeLinkFiles')?.(directory)
    ?? new PosixPrivateFiles(directory, process.getuid?.() ?? -1))
  const files = privateFiles(options.directory)
  const store = new OperationStore(privateFiles(join(options.directory, 'received')), options.maxStoreBytes, options.maxOperations)
  const outgoing = new OperationStore(privateFiles(join(options.directory, 'sent')), options.maxStoreBytes, options.maxOperations)
  const localExecutor = () => {
    const explicit = ctx.get('nodeLinkExecutor')
    if (explicit) return explicit
    const policy = ctx.get('nodeDelegationReceivingPolicy'), authorization = ctx.get('seatAuthorizationTransactions')
    const localSeats = ctx.get('seats'), localAdmission = ctx.get('nodeAuthorizedLocalAdmission')
    if (!policy || !authorization || !localSeats || !localAdmission) return undefined
    const messages = ctx.get('routedMessageReceiver'), messageAuthority = ctx.get('nodeMessageAuthority')
    const seatMessages = ctx.get('routedSeatMessageReceiver')
    return createNodeLinkExecutor({ nodeId: options.nodeId as import('@panedesk/dsh-seat').SeatNodeId,
      peer: { sourceNodeId: options.peerNodeId as import('@panedesk/dsh-seat').SeatNodeId,
        targetNodeId: options.nodeId as import('@panedesk/dsh-seat').SeatNodeId,
        authenticatedAt: new Date().toISOString() }, policy, authorization, localSeats, localAdmission,
      ...(messages === undefined ? {} : { messages }), ...(messageAuthority === undefined ? {} : { messageAuthority }),
      ...(seatMessages === undefined ? {} : { seatMessages }) })
  }
  const receiver = new NodeReceiver(options.nodeId, options.peerNodeId, store, localExecutor)
  let listener: LoopbackListener | undefined, tunnel: SshTunnel | undefined, router: NodeRouter | undefined
  let unlock: (() => Promise<void>) | undefined
  let stopped = false
  let chain: ChainRuntime | undefined
  let slots: ChainSlots | undefined
  let probe: NodeJS.Timeout | undefined
  let probing: Promise<boolean> | undefined
  const ready = (async () => {
    await files.prepare()
    unlock = await files.lock()
    let inbound = await loadCredential(files, 'inbound', options.peerNodeId, options.nodeId, options.credentialOverlapMs)
    let outbound = await loadCredential(files, 'outbound', options.nodeId, options.peerNodeId, options.credentialOverlapMs)
    if ([inbound, ...(inbound.previous ?? [])].some(receiving =>
      [outbound, ...(outbound.previous ?? [])].some(sending => receiving.credential === sending.credential))) {
      throw new Error('Directional credentials must differ')
    }
    await store.load(); await outgoing.load()
    if (inactive()) return
    let credentialsReady = true
    const messageEvidence = new MessageEvidenceChannel(options, () => outbound, () => ctx.get('nodeMessageEvidence'),
      () => !stopped && credentialsReady && router?.isConnected() === true)
    ctx.provide('nodeMessageEvidenceRemote', messageEvidence)
    const services = ctx.get('nodeWorkChain'), business = ctx.get('nodeWorkChainBusiness')
    if (services !== undefined) {
      if (!(business instanceof ChainBusinessRegistry)) throw new Error('Node chain registry unavailable')
      chain = new ChainRuntime(options, services, business, privateFiles, () => outbound,
        () => !stopped && ctx.get('nodeWorkChain') === services && ctx.get('nodeWorkChainBusiness') === business,
        () => credentialsReady && router?.isConnected() === true && (tunnel === undefined || tunnel.available),
        () => router?.disconnect())
      ctx.provide('nodeWorkChainRouter', chain.router)
      void chain.ready().catch((error: unknown) => { void error })
    }
    const dispatch = async (value: unknown, authenticatedEpoch: string): Promise<unknown> => {
      if (!credentialsReady) throw new Error('Directional credentials unavailable')
      if (object(value) && value.type === 'hello') {
        if (value.sourceNodeId !== options.peerNodeId || value.targetNodeId !== options.nodeId
          || !identifier(value.nonce)) throw new Error('Node handshake rejected')
        if (value.version !== NODE_LINK_VERSION) {
          if (chain) return helloRefusal(options.nodeId, value.nonce, authenticatedEpoch,
            'node-protocol-mismatch', 'protocol-version-mismatch')
          throw new Error('Node handshake rejected')
        }
        if (chain) {
          void chain.ready().catch((error: unknown) => { void error })
          try { chain.observe(helloCapability(value)) }
          catch (error) {
            if (value.seatDefinitionRevision === undefined) throw error
            chain.observe(undefined)
            return helloRefusal(options.nodeId, value.nonce, authenticatedEpoch,
              'node-protocol-mismatch', 'protocol-version-mismatch',
              'The peer exact revision capability advertisement is invalid; use seat-definition-revision/v1.')
          }
        }
        const capability = chain?.capability(), executor = localExecutor()
        const status = executor ? await executor.status() : capability && services?.local.seats?.nodeStatus
          ? await services.local.seats.nodeStatus() : undefined
        if (status === undefined) throw new Error('Local node provider unavailable')
        return { version: NODE_LINK_VERSION, nodeId: options.nodeId, epoch: authenticatedEpoch,
          nonce: value.nonce, status, ...helloAdvertisement(capability),
          ...(executor && ctx.get('routedSeatMessageReceiver') && ctx.get('nodeMessageAuthority')
            && ctx.get('nodeDelegationReceivingPolicy')
            ? { seatMessages: 'seat-messages/v1' } : {}) }
      }
      if (object(value) && value.type === 'receipt') {
        const request = decodeRequest(value.request)
        const executor = localExecutor()
        if (request.sourceNodeId !== options.peerNodeId || request.targetNodeId !== options.nodeId
          || Date.parse(request.delegation.expiresAt) <= Date.now() || executor === undefined || !await executor.authorize(request)) {
          throw new Error('Receipt authority rejected')
        }
        return store.query(JSON.stringify([request.sourceNodeId, request.delegation.principalId, request.operationId]),
          digest({ method: request.method, payload: request.payload, principalId: request.delegation.principalId,
            seat: request.delegation.seat ?? null, sessionId: request.delegation.sessionId ?? null, taskIds: request.delegation.taskIds }))
      }
      if (object(value) && value.type === 'message-delegation-evidence') return messageEvidence.receive(value)
      if (chain && object(value) && (value.type === 'delegation-evidence' || isChainMethod(value.method))) {
        const capability = chain.capability()
        if (!capability) throw new Error('Node chain capability unavailable')
        encodeChainFrame(value, chain.limits())
        const response = value.type === 'delegation-evidence'
          ? await chain.evidence.receive(value) : await chain.receive(decodeChainRequest(value))
        encodeChainFrame(response, chain.limits())
        return response
      }
      return receiver.receive(decodeRequest(value))
    }
    const ingress = slots = chain?.slots ?? new ChainSlots(options.maxPending, options.maxPending)
    listener = await listenAuthenticatedLoopback(options.listenPort,
      { ...options, maxPending: ingress.capacity() }, () => inbound,
      (value, epoch) => ingress.run(value, () => dispatch(value, epoch)), {
        forwardedHosts: options.forwardedHosts ?? [],
        rejected: (refusal) => {
          ctx.logger.warn(`${refusal.code} expectedPort=${refusal.expectedPort} actualPort=${refusal.actualPort ?? 'unknown'}`)
        },
      })
    router = new NodeRouter(options, outbound, outgoing, () => !stopped && (tunnel === undefined || tunnel.available),
      chain ? { capability: () => chain?.capability(), observe: capability => chain?.observe(capability) } : undefined,
      () => tunnel?.exhaustedReason)
    if (options.ssh !== undefined) {
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) throw new Error('Node link requires a local subprocess provider')
      tunnel = new SshTunnel(subprocess, options, listener.port, () => router?.disconnect(),
        (level, message) => { ctx.logger[level](message) },
        (kind, safeReason) => router?.observe(kind, safeReason))
      await tunnel.start()
      ctx.provide('hostAdminTransport', { rebuildTransport: async (peerNodeId) => {
        if (stopped || tunnel === undefined || peerNodeId !== undefined && peerNodeId !== options.peerNodeId) {
          return { status: 'unavailable' as const }
        }
        await tunnel.rebuild()
        return { status: 'rebuilt' as const }
      } })
    }
    if (inactive()) return
    ctx.provide('nodeRouter', router)
    const healthRouter = router
    ctx.provide('hostAdminNodeHealth', { status: () => healthRouter.status() })
    await router.handshake()
    if (inactive()) return
    const poll = (): void => {
      if (stopped || router === undefined) return
      const activeRouter = router
      probing = (async () => {
        try {
          const nextInbound = await loadCredential(files, 'inbound', options.peerNodeId, options.nodeId, options.credentialOverlapMs)
          const nextOutbound = await loadCredential(files, 'outbound', options.nodeId, options.peerNodeId, options.credentialOverlapMs)
          if ([nextInbound, ...(nextInbound.previous ?? [])].some(receiving =>
            [nextOutbound, ...(nextOutbound.previous ?? [])].some(sending => receiving.credential === sending.credential))) {
            throw new Error('Directional credentials must differ')
          }
          inbound = nextInbound
          credentialsReady = true
          outbound = nextOutbound
          activeRouter.rotate(nextOutbound)
          return await activeRouter.handshake()
        } catch (error) { void error; credentialsReady = false; activeRouter.disconnect(); return false }
      })()
      void probing.finally(() => { if (!stopped) probe = setTimeout(poll, options.staleMs) })
    }
    probe = setTimeout(poll, options.staleMs)
  })()
  let closing: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    stopped = true
    removeSignals()
    if (probe !== undefined) clearTimeout(probe)
    closing ??= drainRuntime([
      () => ready.catch((error: unknown) => { void error }),
      async () => {
        if (probe !== undefined) clearTimeout(probe)
        const chainClosed = chain?.close()
        await drainRuntime([() => probing, () => chainClosed, () => slots?.close()])
      },
      () => tunnel?.close(),
      () => listener?.close(),
      () => store.close(),
      () => outgoing.close(),
      () => unlock?.(),
    ])
    return closing
  }
  const removeSignals = onRuntimeTermination(dispose, () => { ctx.logger.error('node-link-shutdown-failed: runtime cleanup failed') })
  try { await ready }
  catch (error) { await dispose(); throw error }
  return dispose
}
