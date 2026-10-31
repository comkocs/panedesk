/** Opt-in owner-only approval adapter for the running seat engine. */
import type { Context } from '@panedesk/cordis'
import type Schema from '@panedesk/schemastery'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Remote, RemoteError, TypertRemoteService, observationConfig } from '@panedesk/dsh-typert-protocol'
import type * as Seat from '@panedesk/dsh-seat'
import type { ApprovalQueueView } from './types.ts'

/** Explicit activation and bounded observation of the existing engine. */
export interface Config {
  /** Enable owner-authorized approval operations; disabled by default. */
  enabled: boolean
  /** Delay between queue and operation observations, in milliseconds. */
  pollIntervalMs: number
  /** Maximum engine records requested per observation page. */
  pageSize: number
}

declare module '@panedesk/cordis' {
  interface Context { seatApprovals: SeatApprovals }
}

/** The authenticated owner may confirm pending work, never bypass engine admission. */
export default class SeatApprovals extends TypertRemoteService {
  static Config: Schema<Config> = observationConfig
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<unknown>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'seatApprovals')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.active])
    })
  }

  private owner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('seat-approvals/unauthorized', 'Authenticated owner required', {})
    }
    if (!this.config.enabled || this.lifetime.signal.aborted || this.ctx.invocation.signal.aborted) {
      throw new RemoteError('seat-approvals/unavailable', 'Seat approvals are not enabled', {})
    }
  }

  private unavailable(): never {
    throw new RemoteError('seat-approvals/unavailable', 'Running seat approval capabilities are unavailable', {})
  }

  private async queue(): Promise<ApprovalQueueView> {
    const engine = this.ctx.get('seatEngine')
    if (!engine) return this.unavailable()
    const items: Seat.PendingSeatObservation[] = []
    const rejected: NonNullable<ApprovalQueueView['rejected']>[number][] = []
    let cursor: Seat.EngineCursor | undefined
    do {
      const page = await engine.pending({ limit: this.config.pageSize, includeRejected: true, ...(cursor ? { cursor } : {}) })
      items.push(...page.items.filter(item => item.reason === 'approval' || item.retention !== undefined))
      rejected.push(...page.rejected ?? [])
      if (page.complete) return { enabled: true, items, rejected, complete: true }
      if (!page.nextCursor) return { enabled: true, items, rejected, complete: false }
      cursor = page.nextCursor
    } while (!this.lifetime.signal.aborted)
    return this.unavailable()
  }

  /** Observe pending confirmations without creating an engine or admitting work.
   * @param signal - Remote stream lifetime.
   * @returns complete queue observations; disabled configuration yields no entries.
   */
  @Remote({ mode: 'stream' })
  async *watchPending(signal: AbortSignal): AsyncIterable<ApprovalQueueView> {
    if (!this.config.enabled) { yield { enabled: false, items: [], complete: true }; return }
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    while (!combined.aborted) {
      this.owner()
      yield await this.queue()
      try { await delay(this.config.pollIntervalMs, undefined, { signal: combined }) }
      catch (error) { if (error instanceof Error && error.name === 'AbortError') return; throw error }
    }
  }

  /** Commit approval with the existing transactional engine capability.
   * @param request - Observed queue identity, version and stable operation identity.
   * @returns committed confirmation or the original engine refusal; not an opening receipt.
   */
  @Remote
  approve(request: Seat.ApprovePendingSeatRequest): Promise<Seat.PendingSeatMutationResult> {
    return this.mutate(request, 'approve')
  }

  /** Cancel the observed queue revision without closing an existing window.
   * @param request - Observed queue identity, version and stable operation identity.
   * @returns committed cancellation or the original engine refusal.
   */
  @Remote
  cancel(request: Seat.ApprovePendingSeatRequest): Promise<Seat.PendingSeatMutationResult> {
    return this.mutate(request, 'cancel')
  }

  private mutate(request: Seat.ApprovePendingSeatRequest, action: 'approve' | 'cancel'): Promise<Seat.PendingSeatMutationResult> {
    this.owner()
    const operation = this.commit(request, action)
    this.active.add(operation)
    void operation.then(() => { this.active.delete(operation) }, (_error: unknown) => {
      // The invocation retains and reports the rejection; disposal only tracks settlement.
      this.active.delete(operation)
    })
    return operation
  }

  private async commit(request: Seat.ApprovePendingSeatRequest, action: 'approve' | 'cancel'): Promise<Seat.PendingSeatMutationResult> {
    const engine = this.ctx.get('seatEngine'), transactions = this.ctx.get('seatAuthorizationTransactions')
    const issuers = this.ctx.get('seatAuthorizationIssuers')
    if (!engine || !transactions || !issuers || action === 'cancel' && !transactions.cancel) return this.unavailable()
    const node = await engine.nodeStatus()
    let pending: Seat.PendingSeatItem | undefined
    let cursor: Seat.EngineCursor | undefined
    do {
      const page = await engine.pending({ limit: this.config.pageSize, ...(cursor ? { cursor } : {}) })
      pending = page.items.find(item => item.queueItemId === request.queueItemId)
      if (pending || page.complete || !page.nextCursor) break
      cursor = page.nextCursor
    } while (!this.lifetime.signal.aborted)
    this.owner()
    // These are the complete mutation fields, in the engine's canonical key order.
    const params = { expectedStateVersion: request.expectedStateVersion,
      operationId: request.operationId, queueItemId: request.queueItemId }
    const requestDigest = createHash('sha256').update(JSON.stringify(params)).digest('hex') as Seat.SeatDigest
    const entry = issuers.register({ identity: { kind: 'local-operator', principalId: 'owner' as Seat.SeatPrincipalId,
      nodeId: node.nodeId, origin: 'manual', ...(pending ? { seat: pending.seat } : {}), taskIds: pending?.relatedTaskIds ?? [], policyRevision: 0 },
    current: () => this.config.enabled && !this.lifetime.signal.aborted && this.ctx.invocation?.peer.principal.kind === 'owner'
      && !this.ctx.invocation.signal.aborted
      ? { decision: 'allowed', reasonCode: 'authenticated-owner', policyRevision: 0 } : null })
    try {
      const grant = await entry.issuer.check({ operationId: params.operationId, requestDigest })
      if ('status' in grant) return grant
      if (action === 'cancel') {
        if (!transactions.cancel) return this.unavailable()
        return await transactions.cancel(params, grant)
      }
      return await transactions.approve(params, grant)
    } finally { entry.dispose() }
  }

  /** Observe durable approval and correlated opening progress without replaying writes.
   * @param request - Exact original operation identity.
   * @param signal - Remote stream lifetime.
   * @returns durable progress, including actual opened metadata or a recorded opening failure.
   */
  @Remote({ mode: 'stream' })
  async *watchOperation(request: Seat.SeatOperationQuery, signal: AbortSignal): AsyncIterable<Seat.SeatEngineOperationResult> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    while (!combined.aborted) {
      this.owner()
      const transactions = this.ctx.get('seatAuthorizationTransactions')
      if (!transactions?.operation) return this.unavailable()
      const value = await transactions.operation(request)
      yield value
      if (value.status === 'settled') {
        const result = value.result.status === 'opened' && 'result' in value.result ? value.result.result : value.result
        if (result.status !== 'opened' || result.phase === 'active' || result.phase === 'opening-failed') return
      }
      try { await delay(this.config.pollIntervalMs, undefined, { signal: combined }) }
      catch (error) { if (error instanceof Error && error.name === 'AbortError') return; throw error }
    }
  }
}
