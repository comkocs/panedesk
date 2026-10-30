/** Work-chain sending negotiates explicit capabilities and never blindly replays intent. */
import { callLoopback, LoopbackConnectionError } from '@panedesk/dsh-host-admin'
import { randomUUID } from 'node:crypto'
import type { SeatAuthorizationGrant, SeatAuthorizationIssuer } from '@panedesk/dsh-seat'
import { ChainRetainedEvidence, matchesChainGrant } from './chain-retained.ts'
import type { NodeLinkRuntimeConfig } from './index.ts'
import type { ChannelCredential } from './credentials.ts'
import type { ChainCapability, ChainRequest, ChainResponse } from './chain-types.ts'
import type { ChainRouterService } from './chain-services.ts'
import { chainDigest, decodeChainRequest, decodeChainResponse, encodeChainFrame } from './chain-codec.ts'
import { chainFailure, chainKey, chainKeyText, chainPending, chainRecoveryEligible, chainTransportNone } from './chain-identity.ts'
import { ChainStore } from './chain-store.ts'

/** Transport owns sending records, while business providers own operation progress. */
export class ChainRouter implements ChainRouterService {
  private pending = 0
  private stopped = false
  private readonly active = new Set<Promise<ChainResponse>>()
  private readonly keys = new Map<string, Promise<void>>()
  private recovery: Promise<void> | undefined
  constructor(private readonly options: NodeLinkRuntimeConfig, private readonly store: ChainStore,
    private readonly credential: () => ChannelCredential, private readonly available: () => boolean,
    private readonly capabilities: () => { local?: ChainCapability | undefined; remote?: ChainCapability | undefined },
    private readonly evidence: ChainRetainedEvidence,
    private readonly disconnect?: () => void) {}

  /** Send once; an admitted duplicate remains unknown until an authenticated business query.
   * @param input - Exact frozen request with a fresh entry-issued delegation.
   * @param authorization - Fresh entry grant, retained before any network dispatch.
   * @returns Original correlated receipt or explicit non-execution/unknown outcome.
   */
  route(input: ChainRequest, authorization: SeatAuthorizationGrant): Promise<ChainResponse> {
    if (this.stopped) return Promise.resolve(chainFailure(input, 'node-tunnel-disconnected', 'tunnel-disconnected'))
    const request = decodeChainRequest(structuredClone(input))
    const grant = { ...authorization, fact: structuredClone(authorization.fact) }
    const work = request.method === 'chain.operation' || request.method === 'seat.definitionRevision'
      || request.method === 'source.checkAdmission' ? this.send(request, grant)
      : this.serial(request, () => this.send(request, grant))
    this.active.add(work)
    void work.then(() => { this.active.delete(work) }, () => { this.active.delete(work) })
    return work
  }

  /** Withdraw new sends and await every accepted call before closing persistence.
   * @returns Completion after in-flight calls settle.
   */
  async close(): Promise<void> { this.stopped = true; await Promise.allSettled([...this.active, this.recovery]) }

  private serial<T>(request: ChainRequest, work: () => Promise<T>): Promise<T> {
    const key = chainKeyText(chainKey(request)), previous = this.keys.get(key) ?? Promise.resolve()
    const result = previous.then(work)
    const done = result.then(() => {}, () => {})
    this.keys.set(key, done)
    void done.then(() => { if (this.keys.get(key) === done) this.keys.delete(key) })
    return result
  }

  private async send(input: ChainRequest, authorization: SeatAuthorizationGrant, replay = false): Promise<ChainResponse> {
    const request = decodeChainRequest(input)
    if (this.stopped) return chainFailure(request, 'node-tunnel-disconnected', 'tunnel-disconnected')
    if (!matchesChainGrant(request, authorization)) return chainFailure(request, 'node-delegation-rejected', 'evidence-digest-mismatch')
    if (request.sourceNodeId !== this.options.nodeId || request.targetNodeId !== this.options.peerNodeId) {
      return chainFailure(request, 'node-authentication-failed', 'node-mismatch')
    }
    let pendingQuery = false
    if (request.method === 'chain.operation' && request.payload.key.sourceNodeId === request.sourceNodeId) {
      let previous: ReturnType<ChainStore['query']>
      try { previous = this.store.query(request.payload.key, request.payload.payloadDigest) }
      catch (error) { void error; return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true) }
      if (previous.state === 'settled' && chainTransportNone(previous.response)
        && (!chainRecoveryEligible(request.payload.key.method, previous.response) || !this.available())) {
        return decodeChainResponse({ ...previous.response, method: request.method, requestId: request.requestId }, request)
      }
      pendingQuery = previous.state === 'pending'
      if (pendingQuery && !this.available()) {
        return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true)
      }
    }
    if (!this.available()) return chainFailure(request, 'node-tunnel-disconnected', 'tunnel-disconnected')
    const beforeCallbackDispatch = (code: 'node-deadline-exceeded' | 'cross-node-unsupported',
      reason: 'deadline-exceeded' | 'peer-capability-missing'): ChainResponse => {
      const response = chainFailure(request, code, reason)
      if (response.status !== 'ok' && (request.method === 'source.deliverCallback'
        || request.method === 'chain.operation' && request.payload.key.method === 'source.deliverCallback')) {
        response.error.retryable = true
        response.error.cause.retryable = true
      }
      return response
    }
    const { local, remote } = this.capabilities()
    if (!local || !remote || !remote.methods.includes(request.method)
      || (request.method === 'seat.definitionRevision' && !local.methods.includes(request.method))) {
      return beforeCallbackDispatch('cross-node-unsupported', 'peer-capability-missing')
    }
    if (Date.parse(request.deadline) <= Date.now() || Date.parse(request.delegation.expiresAt) <= Date.now()) {
      return beforeCallbackDispatch('node-deadline-exceeded', 'deadline-exceeded')
    }
    const maxFrameBytes = Math.min(this.options.maxFrameBytes, local.maxFrameBytes, remote.maxFrameBytes)
    try { encodeChainFrame(request, [this.options.maxFrameBytes, local.maxFrameBytes, remote.maxFrameBytes]) }
    catch (error) { void error; return chainFailure(request, 'node-protocol-mismatch', 'frame-too-large') }
    if (!this.available() || this.pending >= this.options.maxPending) return chainFailure(request, 'node-tunnel-disconnected', 'tunnel-disconnected')
    this.pending++
    let admitted = false
    try {
      await this.evidence.retain(request, authorization)
      if (request.method !== 'chain.operation' && request.method !== 'source.checkAdmission'
        && request.method !== 'seat.definitionRevision') {
        const previous = await this.store.admit(request)
        if (previous.state === 'conflict') return chainFailure(request, 'node-operation-conflict', 'operation-payload-conflict')
        if (previous.state === 'settled') return decodeChainResponse({ ...previous.response, requestId: request.requestId }, request)
        if (previous.state !== 'admitted' && !(replay && previous.state === 'pending')) {
          return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true)
        }
        admitted = true
      }
      const remaining = Math.min(Date.parse(request.deadline), Date.parse(request.delegation.expiresAt)) - Date.now()
      if (remaining <= 0) {
        const response = beforeCallbackDispatch('node-deadline-exceeded', 'deadline-exceeded')
        if (admitted) await this.store.settle(request, response, true)
        return response
      }
      const response = decodeChainResponse(await callLoopback(this.options.peerPort, this.credential(), request,
        { ...this.options, maxFrameBytes, requestTimeoutMs: Math.min(this.options.requestTimeoutMs, remaining) }), request)
      if (admitted) await this.store.settle(request, response, false)
      return response
    } catch (error) {
      if (error instanceof LoopbackConnectionError) {
        this.disconnect?.()
        if (pendingQuery) {
          return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true)
        }
        const response = chainFailure(request, 'node-tunnel-disconnected', 'tunnel-disconnected')
        if (admitted) {
          try { await this.store.settle(request, response, true) }
          catch (settlementError) { void settlementError; return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true) }
        }
        return response
      }
      return chainFailure(request, 'node-outcome-unknown', 'outcome-unknown', true)
    }
    finally { this.pending-- }
  }

  /** Recover only locally persisted intents owned by a restricted outbox issuer.
   * @param issuerFor - Host closure checking exact durable intent ownership, never principal-name inference.
   * @returns Completion after one bounded sequential reconciliation pass.
   */
  recover(issuerFor: (request: ChainRequest) => Promise<SeatAuthorizationIssuer | undefined>): Promise<void> {
    return this.recovery ??= this.recoverAll(issuerFor).finally(() => { this.recovery = undefined })
  }

  private async recoverAll(issuerFor: (request: ChainRequest) => Promise<SeatAuthorizationIssuer | undefined>): Promise<void> {
    for (const original of this.store.pending()) {
      if (this.stopped) return
      await this.serial(original, () => this.recoverOne(original, issuerFor))
    }
  }

  private async recoverOne(original: ChainRequest,
    issuerFor: (request: ChainRequest) => Promise<SeatAuthorizationIssuer | undefined>): Promise<void> {
    if (this.stopped || !this.store.pending().some(request => chainKeyText(chainKey(request)) === chainKeyText(chainKey(original)))) return
    const expected = this.store.query(chainKey(original), original.payloadDigest)
    const issuer = await issuerFor(original)
    if (!issuer) return
    const payload = { key: chainKey(original), payloadDigest: original.payloadDigest }
    const grant = await issuer.check({ operationId: original.operationId, requestDigest: chainDigest('chain.operation', payload) })
    if ('status' in grant || grant.fact.principalId !== original.delegation.principalId) return
    const queryDelegation = this.delegation(original, grant)
    const query = decodeChainRequest({ ...original, method: 'chain.operation', payload,
      payloadDigest: grant.fact.requestDigest, requestId: randomUUID(), deadline: queryDelegation.expiresAt,
      delegation: queryDelegation })
    if (query.method !== 'chain.operation') return
    const response = await this.reconcileOne(original, query, grant)
    if (response.status !== 'ok' || response.method !== 'chain.operation' || response.result.status !== 'missing') return
    const replayGrant = await issuer.check({ operationId: original.operationId, requestDigest: original.payloadDigest })
    if ('status' in replayGrant || replayGrant.fact.principalId !== original.delegation.principalId
      || replayGrant.fact.seat !== original.delegation.seat || replayGrant.fact.sessionId !== original.delegation.sessionId
      || JSON.stringify(replayGrant.fact.taskIds) !== JSON.stringify(original.delegation.taskIds)) return
    const replayDelegation = this.delegation(original, replayGrant)
    const replay = decodeChainRequest({ ...original, requestId: randomUUID(),
      deadline: replayDelegation.expiresAt, delegation: replayDelegation })
    if (!await this.store.reactivate(replay, expected)) return
    await this.send(replay, replayGrant, true)
  }

  private delegation(original: ChainRequest, grant: SeatAuthorizationGrant): ChainRequest['delegation'] {
    const fact = grant.fact
    return { kind: 'node-delegation', hop: 1, authorizationRef: fact.authorizationId, principalId: fact.principalId,
      sourceNodeId: original.sourceNodeId, targetNodeId: original.targetNodeId, operationId: fact.operationId,
      requestDigest: fact.requestDigest, taskIds: fact.taskIds, ...(fact.seat === undefined ? {} : { seat: fact.seat }),
      ...(fact.sessionId === undefined ? {} : { sessionId: fact.sessionId }),
      expiresAt: new Date(Date.now() + this.options.requestTimeoutMs).toISOString() }
  }

  /** Repair only a matching already-persisted sender intent from an authenticated query result.
   * @param original - Original immutable request, not a new operation identity.
   * @param query - Authorized exact business query made on this channel.
   * @param authorization - Fresh entry grant for the query payload.
   * @returns Query response; no ordinary method is retried.
   */
  reconcile(original: ChainRequest, query: Extract<ChainRequest, { method: 'chain.operation' }>,
    authorization: SeatAuthorizationGrant): Promise<ChainResponse> {
    const work = this.serial(original, () => this.reconcileOne(original, query, authorization))
    this.active.add(work)
    void work.then(() => { this.active.delete(work) }, () => { this.active.delete(work) })
    return work
  }

  private async reconcileOne(original: ChainRequest, query: Extract<ChainRequest, { method: 'chain.operation' }>,
    authorization: SeatAuthorizationGrant): Promise<ChainResponse> {
    if (chainKeyText(chainKey(original)) !== chainKeyText(query.payload.key) || original.payloadDigest !== query.payload.payloadDigest) {
      return chainFailure(query, 'node-operation-conflict', 'operation-payload-conflict')
    }
    const expected = this.store.query(chainKey(original), original.payloadDigest)
    const response = await this.route(query, authorization)
    if (response.status === 'ok' && response.method === 'chain.operation' && response.result.status === 'settled'
      && response.result.method === original.method) {
      const repair = { ...original, requestId: query.requestId }
      const receipt = decodeChainResponse({ version: original.version, requestId: repair.requestId,
        sourceNodeId: original.sourceNodeId, targetNodeId: original.targetNodeId, operationId: original.operationId,
        method: original.method, status: 'ok', result: response.result.result }, repair)
      if (!chainPending(receipt) && await this.store.reactivate(repair, expected)) await this.store.settle(repair, receipt)
    }
    return response
  }
}
