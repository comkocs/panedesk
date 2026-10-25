/** Authenticated chain ingress queries recovered business owners rather than transport guesses. */
import type { SeatCallContext } from '@panedesk/dsh-seat'
import type { NodeAuthenticatedPeer } from './delegation.ts'
import type { ChainServices } from './chain-services.ts'
import type { ChainRequest, ChainResponse } from './chain-types.ts'
import { chainAuthority } from './chain-authority.ts'
import { chainFailure, chainKey, chainKeyText } from './chain-identity.ts'
import { decodeChainResponse } from './chain-codec.ts'
import { dispatchChain } from './chain-dispatch.ts'
import { ChainBusinessRegistry } from './chain-business.ts'
import { ChainEvidence } from './chain-evidence.ts'
import { ChainStore } from './chain-store.ts'

/** Transport serializes duplicate ingress without holding a lock across independent control calls. */
export class ChainReceiver {
  private readonly active = new Set<string>()
  constructor(private readonly peer: () => NodeAuthenticatedPeer, private readonly services: ChainServices,
    private readonly business: ChainBusinessRegistry, private readonly evidence: ChainEvidence,
    private readonly store: ChainStore, private readonly ready: () => boolean) {}

  /** Authenticate every invocation, including queries and retained transport receipts.
   * @param request - Validated frame from the authenticated paired transport.
   * @returns Exact local result or a nonterminal unknown while business recovery is unavailable.
   */
  async receive(request: ChainRequest): Promise<ChainResponse> {
    if (!this.ready()) return chainFailure(request, 'node-delegation-rejected', 'hello-policy-not-ready')
    try {
      const authority = await chainAuthority(request, this.peer(), this.services.policy, wanted => this.evidence.query(wanted))
      if ('code' in authority) return { ...chainFailure(request, authority.code, authority.cause.reasonCode ?? 'method-not-allowed'),
        status: 'rejected', error: authority }
      if (request.method === 'chain.operation') {
        if (request.payload.key.sourceNodeId !== this.peer().sourceNodeId) {
          return chainFailure(request, 'node-delegation-rejected', 'node-mismatch')
        }
        return this.result(request, await this.business.query(request.payload, authority))
      }
      if (request.method === 'source.checkAdmission') return await dispatchChain(request, authority, this.services.local)
      const key = chainKeyText(chainKey(request))
      if (this.active.has(key)) return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true)
      this.active.add(key)
      try { return await this.execute(request, authority) }
      finally { this.active.delete(key) }
    } catch (error) { void error; return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true) }
  }

  private async execute(request: ChainRequest, authority: SeatCallContext): Promise<ChainResponse> {
    const previous = await this.store.admit(request)
    if (previous.state === 'conflict') return chainFailure(request, 'node-operation-conflict', 'operation-payload-conflict')
    if (previous.state === 'settled') return decodeChainResponse({ ...previous.response, requestId: request.requestId }, request)
    if (previous.state === 'pending') {
      const state = await this.business.query({ key: chainKey(request), payloadDigest: request.payloadDigest }, authority)
      if (state.status === 'settled' && state.method === request.method) {
        const response = this.result(request, state.result)
        await this.store.settle(request, response)
        return response
      }
      if (state.status !== 'missing') return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true)
    }
    // A retransmission carries the same persisted key; the business owner performs atomic admission.
    const response = await dispatchChain(request, authority, this.services.local)
    await this.store.settle(request, response)
    return response
  }

  private result(request: ChainRequest, result: unknown): ChainResponse {
    return decodeChainResponse({ version: request.version, requestId: request.requestId, sourceNodeId: request.sourceNodeId,
      targetNodeId: request.targetNodeId, operationId: request.operationId, method: request.method, status: 'ok', result }, request)
  }
}
