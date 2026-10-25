/** Exact same-channel evidence calls use independent bounded control slots. */
import { randomUUID } from 'node:crypto'
import { callLoopback, digest } from '@panedesk/dsh-host-admin'
import type * as Seat from '@panedesk/dsh-seat'
import type { NodeLinkRuntimeConfig } from './index.ts'
import type { ChannelCredential } from './credentials.ts'
import type { ChainEvidenceService } from './chain-services.ts'
import type { ChainCapability, ChainEvidenceFrame, ChainEvidenceResponse } from './chain-types.ts'
import { decodeEvidenceFrame, decodeEvidenceResponse, encodeChainFrame } from './chain-codec.ts'

/** Control capacity is separate from in-flight business execution on the same authenticated channel. */
export class ChainEvidence {
  private incoming = 0
  private outgoing = 0
  constructor(private readonly options: NodeLinkRuntimeConfig, private readonly maxPending: number,
    private readonly service: ChainEvidenceService, private readonly credential: () => ChannelCredential,
    private readonly remote: () => ChainCapability | undefined) {}

  /** Fetch an exact original fact from its declared issuing node, without delegation recursion.
   * @param request - Original reference and complete operation identity.
   * @returns Independently retained evidence; unavailable capacity rejects.
   */
  async query(request: Seat.NodeDelegationEvidenceRequest): Promise<Seat.NodeDelegationEvidenceResult> {
    const remote = this.remote()
    if (!remote || request.sourceNodeId !== this.options.peerNodeId || request.targetNodeId !== this.options.nodeId
      || this.outgoing >= this.maxPending) throw new Error('Node evidence channel unavailable')
    const frame: ChainEvidenceFrame = { type: 'delegation-evidence', version: 'node-link/v1',
      requestId: randomUUID() as ChainEvidenceFrame['requestId'], request }
    encodeChainFrame(frame, [this.options.maxFrameBytes, Math.min(this.options.maxFrameBytes, 1048576), remote.maxFrameBytes])
    this.outgoing++
    try {
      return decodeEvidenceResponse(await callLoopback(this.options.peerPort, this.credential(), frame,
        { ...this.options, maxFrameBytes: Math.min(this.options.maxFrameBytes, remote.maxFrameBytes, 1048576) }), frame).result
    } finally { this.outgoing-- }
  }

  /** Serve only evidence issued here for the authenticated paired requester.
   * @param value - Parsed authenticated control frame.
   * @returns Correlated independent evidence, never an arbitrary authorization search.
   */
  async receive(value: unknown): Promise<ChainEvidenceResponse> {
    const frame = decodeEvidenceFrame(value), request = frame.request
    if (request.sourceNodeId !== this.options.nodeId || request.targetNodeId !== this.options.peerNodeId
      || this.incoming >= this.maxPending) throw new Error('Node evidence peer rejected')
    this.incoming++
    try {
      const result = await this.service.query(request, { sourceNodeId: request.targetNodeId,
        targetNodeId: request.sourceNodeId, authenticatedAt: new Date().toISOString() })
      if (result.status === 'retained' && digest(result.request) !== digest(request)) throw new Error('Node evidence identity rejected')
      const response = decodeEvidenceResponse({ type: frame.type, version: frame.version, requestId: frame.requestId, result }, frame)
      const remote = this.remote()
      if (!remote) throw new Error('Node evidence capability unavailable')
      encodeChainFrame(response, [this.options.maxFrameBytes, Math.min(this.options.maxFrameBytes, 1048576), remote.maxFrameBytes])
      return response
    } finally { this.incoming-- }
  }
}
