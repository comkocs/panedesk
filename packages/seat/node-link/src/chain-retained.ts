/** Durable exact evidence belongs to the paired sender, not the business composition. */
import { digest, object, parseJson, type PrivateFiles } from '@panedesk/dsh-host-admin'
import { decodeNodeDelegationEvidenceResult } from '@panedesk/dsh-sdk-protocol'
import type * as Seat from '@panedesk/dsh-seat'
import type { NodeAuthenticatedPeer } from './delegation.ts'
import type { ChainEvidenceService } from './chain-services.ts'
import type { ChainRequest } from './chain-types.ts'

type Retained = Extract<Seat.NodeDelegationEvidenceResult, { status: 'retained' }>

/** Compare the live entry grant before publishing evidence or creating a sending intent.
 * @param request - Decoded frozen request.
 * @param authorization - Entry-issued process-local authority.
 * @returns Whether the fact exactly matches the single-hop delegation.
 */
export function matchesChainGrant(request: ChainRequest, authorization: Seat.SeatAuthorizationGrant): boolean {
  const fact = authorization.fact, delegation = request.delegation
  return fact.decision === 'allowed' && fact.kind !== 'node-delegation'
    && fact.authorizationId === delegation.authorizationRef && fact.nodeId === request.sourceNodeId
    && fact.principalId === delegation.principalId && fact.operationId === request.operationId
    && fact.requestDigest === request.payloadDigest && fact.seat === delegation.seat
    && fact.sessionId === delegation.sessionId && digest(fact.taskIds) === digest(delegation.taskIds)
    && Number.isFinite(Date.parse(fact.checkedAt)) && Date.parse(fact.checkedAt) <= Date.now()
    && Date.parse(delegation.expiresAt) > Date.now() && Date.parse(delegation.expiresAt) <= Date.parse(request.deadline)
}

/** Failed publication disables reads until restart; capacity never evicts live evidence. */
export class ChainRetainedEvidence implements ChainEvidenceService {
  private entries: Record<string, Retained> = {}
  private loading: Promise<void> | undefined
  private serial: Promise<void> = Promise.resolve()
  private failed = false
  constructor(private readonly files: PrivateFiles, private readonly maxBytes: number, private readonly maxEntries: number,
    private readonly nodeId: string, private readonly peerId: string) {}

  ready(): Promise<void> { return this.loading ??= this.load() }

  private async load(): Promise<void> {
    await this.files.prepare()
    const text = await this.files.read('evidence-v1.json', this.maxBytes)
    if (text === null) return
    const value = parseJson(text, this.maxBytes)
    if (!object(value) || value.version !== 'node-work-chain-evidence/v1' || !object(value.entries)
      || Object.keys(value.entries).length > this.maxEntries) throw new Error('Node chain evidence store rejected')
    for (const [key, input] of Object.entries(value.entries)) {
      const entry = decodeNodeDelegationEvidenceResult(input)
      if (entry.status !== 'retained' || key !== digest(entry.request) || entry.request.sourceNodeId !== this.nodeId
        || entry.request.targetNodeId !== this.peerId || entry.fact.nodeId !== this.nodeId
        || entry.fact.authorizationId !== entry.request.authorizationRef || entry.fact.operationId !== entry.request.operationId
        || entry.fact.requestDigest !== entry.request.payloadDigest || entry.fact.kind === 'node-delegation'
        || entry.fact.decision !== 'allowed') throw new Error('Node chain evidence identity rejected')
      this.entries[key] = entry
    }
    const live = this.live()
    if (Object.keys(live).length !== Object.keys(this.entries).length) await this.publish(live)
  }

  /** Publish the fact before sending; no process-local grant is serialized.
   * @param request - Exact authenticated sending intent.
   * @param authorization - Fresh matching entry grant.
   * @returns Completion after bounded durable publication.
   */
  async retain(request: ChainRequest, authorization: Seat.SeatAuthorizationGrant): Promise<void> {
    await this.ready()
    if (!matchesChainGrant(request, authorization) || request.sourceNodeId !== this.nodeId || request.targetNodeId !== this.peerId) {
      throw new Error('Node chain sending authority rejected')
    }
    const entry: Retained = { status: 'retained', request: { authorizationRef: request.delegation.authorizationRef,
      method: request.method, operationId: request.operationId, payloadDigest: request.payloadDigest,
      sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId }, fact: structuredClone(authorization.fact),
    expiresAt: request.delegation.expiresAt, revoked: false }
    const work = this.serial.then(async () => {
      if (this.failed) throw new Error('Node chain evidence unavailable')
      const entries = this.live(), key = digest(entry.request), previous = entries[key]
      if (previous && digest(previous) !== digest(entry)) throw new Error('Node chain evidence conflict')
      entries[key] = entry
      if (Object.keys(entries).length > this.maxEntries) throw new Error('Node chain evidence capacity exceeded')
      await this.publish(entries)
    })
    this.serial = work.then(() => {}, () => {})
    await work
  }

  async query(request: Seat.NodeDelegationEvidenceRequest, peer: NodeAuthenticatedPeer): Promise<Seat.NodeDelegationEvidenceResult> {
    await this.ready()
    if (this.failed) throw new Error('Node chain evidence unavailable')
    const entry = this.entries[digest(request)]
    if (peer.sourceNodeId === this.peerId && peer.targetNodeId === this.nodeId
      && request.sourceNodeId === this.nodeId && request.targetNodeId === this.peerId
      && entry && Date.parse(entry.expiresAt) > Date.now()) return structuredClone(entry)
    return { status: 'rejected', cause: { domain: 'node-link', code: 'node-delegation-rejected',
      reason: 'evidence-missing', reasonCode: 'evidence-missing', effectState: 'none', retryable: false,
      operationId: request.operationId, nodeId: request.sourceNodeId } }
  }

  /** Drain every accepted evidence publication before releasing directory ownership.
   * @returns Completion after queued publications settle.
   */
  async close(): Promise<void> { await this.serial }

  private live(): Record<string, Retained> {
    return Object.fromEntries(Object.entries(this.entries).filter(([, entry]) => Date.parse(entry.expiresAt) > Date.now()))
  }
  private async publish(entries: Record<string, Retained>): Promise<void> {
    const text = JSON.stringify({ version: 'node-work-chain-evidence/v1', entries })
    if (Buffer.byteLength(text) > this.maxBytes) throw new Error('Node chain evidence exceeds limit')
    try { await this.files.write('evidence-v1.json', text) }
    catch (error) { this.failed = true; throw error }
    this.entries = entries
  }
}
