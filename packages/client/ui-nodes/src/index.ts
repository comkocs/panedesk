/** Owner-only settings bridge reuses the running host's observation and operator executors. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import { readNodeHealth, executeNodeOperator, decodeHostAdminRequest } from '@panedesk/dsh-host-admin'
import type { HostAdminRequest, HostAdminAuthority } from '@panedesk/dsh-host-admin'
import type { NodeHealthView } from '@panedesk/dsh-host-admin/types'
import type * as Seat from '@panedesk/dsh-seat'
import type { NodeAction, NodeActionResult } from './types.ts'

/** Availability and polling are deployment configuration, not client-owned authority. */
export interface Config {
  /** Whether authenticated owners can read observations and submit confirmed operations. */
  enabled: boolean
  /** Polling interval in milliseconds returned to browser observation consumers. */
  refreshIntervalMs: number
  /** Maximum callback and source-operation rows requested from each provider. */
  pageSize: number
}

declare module '@panedesk/cordis' {
  interface Context { nodes: NodesService }
}

/** The browser cannot supply a principal, grant, host epoch or arbitrary administrative method. */
export default class NodesService extends TypertRemoteService {
  static Config: Schema<Config> = Schema.object({
    enabled: Schema.boolean().default(true),
    refreshIntervalMs: Schema.number().min(1000).max(2147483647).step(1).default(10000),
    pageSize: Schema.number().min(1).max(200).step(1).default(200),
  })
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<NodeActionResult>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'nodes')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.active])
    })
  }

  private invocation(): () => boolean {
    const invocation = this.ctx.invocation
    if (!this.config.enabled) throw new RemoteError('nodes/disabled', 'Node settings are disabled', {})
    const current = () => !this.lifetime.signal.aborted && !invocation?.signal.aborted
    if (!current()) throw new RemoteError('nodes/unavailable', 'Node settings are unavailable', {})
    return current
  }

  /** Read installed node and live callback providers without starting an engine or sending work.
   * @returns Current provider observations and the configured polling interval.
   */
  @Remote
  async read(): Promise<{ view: NodeHealthView; refreshIntervalMs: number }> {
    const current = this.invocation()
    const view = await readNodeHealth(this.ctx, this.config.pageSize)
    if (!current()) throw new RemoteError('nodes/unavailable', 'Node settings are unavailable', {})
    return { view, refreshIntervalMs: this.config.refreshIntervalMs }
  }

  /** Execute one explicitly confirmed action under the authenticated owner's existing local-operator path.
   * @param action - Fixed local tunnel, callback resolution or source-owner action.
   * @returns Provider refusal, uncertainty or committed evidence; a transport failure is never success.
   */
  @Remote
  act(action: NodeAction): Promise<NodeActionResult> {
    const current = this.invocation()
    const operation = this.execute(action, current)
    this.active.add(operation)
    void operation.then(() => { this.active.delete(operation) }, (_error: unknown) => {
      // The Remote invocation reports the rejection; teardown only waits for settlement.
      this.active.delete(operation)
    })
    return operation
  }

  private async execute(action: NodeAction, current: () => boolean): Promise<NodeActionResult> {
    const id = randomUUID()
    const base = { version: 'host-admin/v1' as const,
      requestId: id as HostAdminRequest['requestId'], nonce: id as HostAdminRequest['nonce'],
      processEpoch: id as HostAdminRequest['processEpoch'] }
    let request: HostAdminRequest
    switch (action.kind) {
      case 'rebuild': request = { ...base, method: 'node.rebuild', params: { peerNodeId: action.peerNodeId } }; break
      case 'callback': request = { ...base, method: 'engine.callbackResolve', params: action.request }; break
      case 'source': request = { ...base, method: action.action === 'resume' ? 'source.resend' : 'source.abandon',
        params: { operationId: action.operationId, key: action.key, reason: action.reason } }; break
    }
    try { request = decodeHostAdminRequest(request) }
    catch (_error: unknown) { return { status: 'rejected', code: 'admin-request-invalid' } }
    const authority: HostAdminAuthority = { kind: 'local-operator', principalId: 'owner' as Seat.SeatPrincipalId,
      authorizationRef: id as Seat.AuthorizationRef, methods: [request.method] }
    const response = await executeNodeOperator(this.ctx, request, authority, current)
    if (!response) return { status: 'unavailable', code: 'admin-method-unavailable' }
    if (response.status !== 'ok') return { status: response.status, code: response.code }
    switch (response.method) {
      case 'node.rebuild': return { status: response.result.status === 'rebuilt' ? 'ok' : 'unavailable' }
      case 'engine.callbackResolve':
      case 'source.abandon':
      case 'source.resend': return response.result.status === 'ok' ? { status: 'ok' }
        : { status: 'rejected', ...('code' in response.result ? { code: response.result.code } : {}) }
      default: return { status: 'unavailable', code: 'admin-method-unavailable' }
    }
  }
}
