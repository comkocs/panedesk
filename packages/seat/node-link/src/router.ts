/** Router refuses offline writes and retains unknown operation identities until reconciliation. */
import { randomUUID } from 'node:crypto'
import { callLoopback, digest, object, OperationStore, LoopbackHostMismatchError } from '@panedesk/dsh-host-admin'
import { decodeSeatResult } from '@panedesk/dsh-sdk-protocol'
import { NODE_LINK_VERSION } from './index.ts'
import type { NodeLinkRuntimeConfig, NodeRouterService, NodeWireRequest, NodeWireResponse, NodeLinkStatus } from './index.ts'
import type { ChannelCredential } from './credentials.ts'
import { decodeRequest, decodeResponse } from './codec.ts'
import { failure } from './receiver.ts'
import { decodeHelloRefusal, helloCapability, helloAdvertisement, type ChainHelloHooks } from './chain-hello.ts'

/** One paired peer owns health observations and bounded outbound calls. */
export class NodeRouter implements NodeRouterService {
  private connected = false
  private pending = 0
  private statusValue: NodeLinkStatus
  constructor(private readonly options: NodeLinkRuntimeConfig, private credential: ChannelCredential,
    private readonly outgoing: OperationStore, private readonly available: () => boolean,
    private readonly chain?: ChainHelloHooks) {
    this.statusValue = { nodeId: options.peerNodeId as NodeLinkStatus['nodeId'], nodeName: options.peerName,
      reachable: false, linkState: 'disconnected', observedAt: new Date().toISOString(),
      status: null, capabilities: [], safeReason: 'node-tunnel-disconnected' }
  }
  /** Replace outbound authentication only after a checked private-file reload.
   * @param credential - Newly loaded directional credential.
   */
  rotate(credential: ChannelCredential): void {
    if (credential.epoch !== this.credential.epoch || credential.credential !== this.credential.credential) this.disconnect()
    this.credential = credential
  }
  /** Mark only transport state; retained self-reported counts are never rewritten to zero. */
  disconnect(): void { this.connected = false; this.chain?.observe(undefined); this.statusValue = { ...this.statusValue, reachable: false,
    linkState: 'disconnected', safeReason: 'node-tunnel-disconnected',
    capabilities: this.statusValue.capabilities.filter(capability => capability !== 'node-work-chain/v1') } }
  /** Read the last authenticated connection observation without starting a probe.
   * @returns Whether routing has observed a connection that has not been withdrawn.
   */
  isConnected(): boolean { return this.connected }
  /** Authenticate epoch and node identity before allowing new writes.
   * @returns Whether a bounded authenticated self-report was obtained.
   */
  async handshake(): Promise<boolean> {
    let revision = false
    try {
      const nonce = randomUUID(), credential = this.credential, chain = this.chain?.capability()
      revision = chain?.methods.includes('seat.definitionRevision') === true
      if (!this.available()) {
        this.disconnect()
        if (revision) this.statusValue = { ...this.statusValue,
          safeReason: 'tunnel-disconnected: The peer transport is unavailable; exact revision reads are unavailable.' }
        return false
      }
      const value = await callLoopback(this.options.peerPort, credential, { type: 'hello', version: NODE_LINK_VERSION,
        sourceNodeId: this.options.nodeId, targetNodeId: this.options.peerNodeId, nonce,
        ...helloAdvertisement(chain) }, this.options, true)
      if (!object(value) || value.version !== NODE_LINK_VERSION || value.nonce !== nonce || value.nodeId !== this.options.peerNodeId
        || value.epoch !== credential.epoch || this.credential !== credential) throw new Error('Node handshake rejected')
      const refusal = this.chain === undefined ? undefined : decodeHelloRefusal(value)
      if (refusal !== undefined) {
        this.disconnect()
        this.statusValue = { ...this.statusValue, safeReason: revision
          ? `${refusal.reasonCode ?? refusal.code}: ${refusal.reason}` : refusal.reasonCode ?? refusal.code }
        return false
      }
      const status = decodeSeatResult('seats/nodeStatus', value.status)
      if (status.nodeId !== this.options.peerNodeId) throw new Error('Node status identity rejected')
      const peerChain = this.chain === undefined ? undefined : helloCapability(value)
      this.chain?.observe(peerChain)
      this.statusValue = { ...this.statusValue, reachable: true, linkState: 'connected', status,
        observedAt: new Date().toISOString(), capabilities: [NODE_LINK_VERSION,
          ...(chain !== undefined && peerChain !== undefined ? ['node-work-chain/v1'] : [])],
        safeReason: revision && !peerChain?.methods.includes('seat.definitionRevision')
          ? 'peer-capability-missing: The peer does not advertise seat-definition-revision/v1; exact revision reads are unavailable.' : null }
      this.connected = true
      return true
    } catch (error) {
      this.disconnect()
      if (error instanceof LoopbackHostMismatchError) this.statusValue = { ...this.statusValue, safeReason: revision
        ? `${error.code}: The peer transport identity does not match; exact revision reads are unavailable.` : error.code }
      else if (revision) this.statusValue = { ...this.statusValue,
        safeReason: 'authentication-unconfirmed: The peer handshake could not be authenticated or decoded; exact revision reads are unavailable.' }
      return false
    }
  }
  /** Route an exact operation or reconcile its retained unknown outcome.
   * @param input - Prepared request with entry-issued single-hop delegation.
   * @returns Correlated peer result or explicit non-execution/unknown failure.
   */
  async route(input: NodeWireRequest): Promise<NodeWireResponse> {
    const request = decodeRequest(input)
    if (request.sourceNodeId !== this.options.nodeId || request.targetNodeId !== this.options.peerNodeId) {
      return failure(request, 'cross-node-unsupported')
    }
    if (Date.parse(request.deadline) <= Date.now()) return failure(request, 'node-deadline-exceeded')
    if (!this.available() || !this.connected || this.pending >= this.options.maxPending) return failure(request, 'node-tunnel-disconnected')
    this.pending++
    try {
      if (request.method === 'seat.operation') {
        return decodeResponse(await callLoopback(this.options.peerPort, this.credential, request, this.bounded(request)), request)
      }
      const identity = JSON.stringify([request.delegation.principalId, request.operationId])
      const fingerprint = digest({ method: request.method, payload: request.payload, delegation: {
        principalId: request.delegation.principalId, seat: request.delegation.seat ?? null,
        sessionId: request.delegation.sessionId ?? null, taskIds: request.delegation.taskIds } })
      const previous = this.outgoing.query(identity)
      if (previous.state === 'missing' && this.outgoing.hasPending) return failure(request, 'node-outcome-unknown', true)
      const outcome = previous.state === 'pending'
        ? await this.outgoing.reconcile(identity, fingerprint, async () => {
          const receipt = await callLoopback(this.options.peerPort, this.credential, { type: 'receipt', request }, this.bounded(request))
          if (!object(receipt) || receipt.state !== 'settled' || !object(receipt.result)) return { state: 'pending' }
          return { state: 'settled', result: decodeResponse({ ...receipt.result, requestId: request.requestId }, request) }
        })
        : await this.outgoing.run(identity, fingerprint, async () => {
          const response = decodeResponse(
            await callLoopback(this.options.peerPort, this.credential, request, this.bounded(request)), request)
          if (response.status !== 'ok' && response.error.effectState === 'unknown') throw new Error('Remote outcome unresolved')
          return response
        })
      if (outcome.state === 'conflict') return failure(request, 'node-operation-conflict')
      if (outcome.state !== 'settled') return failure(request, 'node-outcome-unknown', true)
      if (!object(outcome.result)) return failure(request, 'node-outcome-unknown', true)
      return decodeResponse({ ...outcome.result, requestId: request.requestId }, request)
    } catch (error) { void error; this.disconnect(); return failure(request, 'node-outcome-unknown', true) }
    finally { this.pending-- }
  }
  private bounded(request: NodeWireRequest): NodeLinkRuntimeConfig {
    return { ...this.options,
      requestTimeoutMs: Math.max(1, Math.min(this.options.requestTimeoutMs, Date.parse(request.deadline) - Date.now())) }
  }
  status(): Promise<readonly NodeLinkStatus[]> {
    const stale = Date.now() - Date.parse(this.statusValue.observedAt) >= this.options.staleMs
    return Promise.resolve([{ ...this.statusValue, ...(stale ? { linkState: 'stale' as const, reachable: false } : {}) }])
  }
}
