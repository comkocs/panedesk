/** Optional message evidence uses the existing authenticated directional transport. */
import { randomUUID } from 'node:crypto'
import { callLoopback, object } from '@panedesk/dsh-host-admin'
import type { NodeAuthenticatedPeer, NodePreparedRequest } from './delegation.ts'
import type { NodeLinkRuntimeConfig } from './index.ts'
import type { ChannelCredential } from './credentials.ts'
import { decodeRequest } from './codec.ts'

/** Host-owned evidence is queried independently of the execution request's claimed authority. */
export interface NodeMessageEvidence {
  /** @param request - Exact decoded message request.
   * @param peer - Transport-authenticated requester. @returns Independently retained evidence or null.
   */
  query(request: NodePreparedRequest, peer: NodeAuthenticatedPeer): Promise<unknown>
}
/** Paired transport captures direction and credentials; callers cannot select an endpoint. */
export interface NodeMessageEvidenceRemote {
  /** @param request - Exact request received from this paired peer. @returns Independent peer evidence or null. */
  query(request: NodePreparedRequest): Promise<unknown>
}
declare module '@panedesk/cordis' {
  interface Context {
    nodeMessageEvidence: NodeMessageEvidence
    nodeMessageEvidenceRemote: NodeMessageEvidenceRemote
  }
}
/** Bounded control calls remain separate from message execution slots to avoid nested-call deadlock. */
export class MessageEvidenceChannel implements NodeMessageEvidenceRemote {
  private incoming = 0
  private outgoing = 0
  constructor(private readonly options: NodeLinkRuntimeConfig, private readonly credential: () => ChannelCredential,
    private readonly service: () => NodeMessageEvidence | undefined, private readonly available: () => boolean) {}

  async query(request: NodePreparedRequest): Promise<unknown> {
    if (!this.available() || request.sourceNodeId !== this.options.peerNodeId || request.targetNodeId !== this.options.nodeId
      || this.outgoing >= this.options.maxPending) throw new Error('Message evidence channel unavailable')
    const requestId = randomUUID()
    this.outgoing++
    try {
      const value = await callLoopback(this.options.peerPort, this.credential(),
        { type: 'message-delegation-evidence', version: 'node-link/v1', requestId, request }, this.options)
      if (!object(value) || value.type !== 'message-delegation-evidence' || value.version !== 'node-link/v1'
        || value.requestId !== requestId || Object.keys(value).some(key => !['type', 'version', 'requestId', 'evidence'].includes(key))) {
        throw new Error('Message evidence response rejected')
      }
      return value.evidence
    } finally { this.outgoing-- }
  }

  /** @param value - Authenticated control frame. @returns Correlated evidence from the local owner only. */
  async receive(value: unknown): Promise<unknown> {
    if (!object(value) || value.type !== 'message-delegation-evidence' || value.version !== 'node-link/v1'
      || typeof value.requestId !== 'string' || !value.requestId || value.requestId.length > 128
      || Object.keys(value).some(key => !['type', 'version', 'requestId', 'request'].includes(key))) {
      throw new Error('Message evidence request rejected')
    }
    const request = decodeRequest(value.request), service = this.service()
    if (!service || request.sourceNodeId !== this.options.nodeId || request.targetNodeId !== this.options.peerNodeId
      || !['messages.sendSeat', 'messages.onlineSeats'].includes(request.method)
      || this.incoming >= this.options.maxPending) throw new Error('Message evidence peer rejected')
    this.incoming++
    try {
      const evidence = await service.query(request, { sourceNodeId: request.targetNodeId, targetNodeId: request.sourceNodeId,
        authenticatedAt: new Date().toISOString() })
      return { type: value.type, version: value.version, requestId: value.requestId, evidence }
    } finally { this.incoming-- }
  }
}
