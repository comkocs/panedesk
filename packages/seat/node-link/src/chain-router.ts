/** Work-chain sending negotiates explicit capabilities and never blindly replays intent. */
import { callLoopback } from '@panedesk/dsh-host-admin'
import type { NodeLinkRuntimeConfig } from './index.ts'
import type { ChannelCredential } from './credentials.ts'
import type { ChainCapability, ChainRequest, ChainResponse } from './chain-types.ts'
import type { ChainRouterService } from './chain-services.ts'
import { decodeChainRequest, decodeChainResponse, encodeChainFrame } from './chain-codec.ts'
import { chainFailure, chainKey, chainKeyText } from './chain-identity.ts'
import { ChainStore } from './chain-store.ts'

/** Transport owns sending records, while business providers own operation progress. */
export class ChainRouter implements ChainRouterService {
  private pending = 0
  constructor(private readonly options: NodeLinkRuntimeConfig, private readonly store: ChainStore,
    private readonly credential: () => ChannelCredential, private readonly available: () => boolean,
    private readonly capabilities: () => { local?: ChainCapability; remote?: ChainCapability }) {}

  /** Send once; an admitted duplicate remains unknown until an authenticated business query.
   * @param input - Exact frozen request with a fresh entry-issued delegation.
   * @returns Original correlated receipt or explicit non-execution/unknown outcome.
   */
  async route(input: ChainRequest): Promise<ChainResponse> {
    const request = decodeChainRequest(input), { local, remote } = this.capabilities()
    if (!local || !remote || !remote.methods.includes(request.method)) {
      return chainFailure(request, 'cross-node-unsupported', 'peer-capability-missing')
    }
    if (request.sourceNodeId !== this.options.nodeId || request.targetNodeId !== this.options.peerNodeId) {
      return chainFailure(request, 'node-authentication-failed', 'node-mismatch')
    }
    if (Date.parse(request.deadline) <= Date.now() || Date.parse(request.delegation.expiresAt) <= Date.now()) {
      return chainFailure(request, 'node-deadline-exceeded', 'deadline-exceeded')
    }
    const maxFrameBytes = Math.min(this.options.maxFrameBytes, local.maxFrameBytes, remote.maxFrameBytes)
    try { encodeChainFrame(request, [this.options.maxFrameBytes, local.maxFrameBytes, remote.maxFrameBytes]) }
    catch (error) { void error; return chainFailure(request, 'node-protocol-mismatch', 'frame-too-large') }
    if (!this.available() || this.pending >= this.options.maxPending) return chainFailure(request, 'node-tunnel-disconnected', 'tunnel-disconnected')
    this.pending++
    let admitted = false
    try {
      if (request.method !== 'chain.operation' && request.method !== 'source.checkAdmission') {
        const previous = await this.store.admit(request)
        if (previous.state === 'conflict') return chainFailure(request, 'node-operation-conflict', 'operation-payload-conflict')
        if (previous.state === 'settled') return decodeChainResponse({ ...previous.response, requestId: request.requestId }, request)
        if (previous.state !== 'admitted') return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true)
        admitted = true
      }
      const response = decodeChainResponse(await callLoopback(this.options.peerPort, this.credential(), request,
        { ...this.options, maxFrameBytes, requestTimeoutMs: Math.max(1, Math.min(this.options.requestTimeoutMs,
          Date.parse(request.deadline) - Date.now())) }), request)
      if (admitted) await this.store.settle(request, response)
      return response
    } catch (error) { void error; return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true) }
    finally { this.pending-- }
  }

  /** Repair only a matching already-persisted sender intent from an authenticated query result.
   * @param original - Original immutable request, not a new operation identity.
   * @param query - Authorized exact business query made on this channel.
   * @returns Query response; no ordinary method is retried.
   */
  async reconcile(original: ChainRequest, query: Extract<ChainRequest, { method: 'chain.operation' }>): Promise<ChainResponse> {
    if (chainKeyText(chainKey(original)) !== chainKeyText(query.payload.key) || original.payloadDigest !== query.payload.payloadDigest) {
      return chainFailure(query, 'node-operation-conflict', 'operation-payload-conflict')
    }
    const response = await this.route(query)
    if (response.status === 'ok' && response.method === 'chain.operation' && response.result.status === 'settled'
      && response.result.method === original.method) {
      await this.store.settle(original, decodeChainResponse({ version: original.version, requestId: original.requestId,
        sourceNodeId: original.sourceNodeId, targetNodeId: original.targetNodeId, operationId: original.operationId,
        method: original.method, status: 'ok', result: response.result.result }, original))
    }
    return response
  }
}
