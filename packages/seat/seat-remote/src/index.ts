/** Authenticated seat Remote consumer; window policy remains in SeatService. */
import { Context } from '@panedesk/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import { decodeSeatRequest, type SeatRequestMap } from '@panedesk/dsh-sdk-protocol'
import type { SeatCallContext, SeatService } from '@panedesk/dsh-seat'
import z from '@panedesk/schemastery'
import { registerWebhook, type WebhookOptions } from './webhook.ts'

/** Optional external ingress is disabled unless explicit source policy is configured. */
export interface Config {
  /** Signed external ingress policy; omitted leaves the webhook route unregistered. */
  webhook?: Omit<WebhookOptions, 'audit'>
}

declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'seat/unauthorized': Record<string, never>
    'seat/unavailable': Record<string, never>
  }
}

declare module '@panedesk/cordis' {
  interface Context { seatRemote: SeatRemote }
}

/** Host owner of the seats namespace; absent providers never activate a replacement runtime. */
export class SeatRemote extends TypertRemoteService {
  static Config = z.object({ webhook: z.object({ path: z.string().required(), maxBodyBytes: z.natural().min(1).required(),
    bodyTimeoutMs: z.natural().min(1).required(), maxClockSkewMs: z.natural().required(),
    sources: z.array(z.object({ sourceId: z.string().required(), seat: z.string().required(),
      projectId: z.string().required(), credentialRefs: z.dict(z.string()).required() })).required() }).default(undefined as never) })

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'seatRemote', { namespace: 'seats' })
    if (config.webhook) registerWebhook(ctx, { ...config.webhook, audit: async (fact) => {
      const engine = ctx.get('seatEngine')
      if (!engine) throw new Error('Seat audit provider is unavailable')
      await engine.auditSourceRejection(fact)
    } })
  }

  private async scoped(): Promise<SeatService> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new RemoteError('seat/unauthorized', 'Seat operations require the authenticated owner', {})
    const seats = this.ctx.get('seats'), engine = this.ctx.get('seatEngine')
    if (!seats || !engine) throw new RemoteError('seat/unavailable', 'Seat providers are unavailable', {})
    const node = await engine.nodeStatus()
    return seats.withAuthority({ principalId: 'owner' as SeatCallContext['principalId'], origin: 'remote', nodeId: node.nodeId })
  }

  private engine() {
    const engine = this.ctx.get('seatEngine')
    if (!engine) throw new RemoteError('seat/unavailable', 'Seat providers are unavailable', {})
    return engine
  }

  /** Preview source rows without mutating the catalog.
   * @param request - source, mapping and defaults.
   * @returns revision-bound row comparisons.
   */
  @Remote('import.preview')
  async previewImport(request: SeatRequestMap['seats/import.preview']['params']): Promise<SeatRequestMap['seats/import.preview']['result']> {
    return (await this.scoped()).previewImport(decodeSeatRequest('seats/import.preview', request))
  }
  /** Commit selected rows against the original preview revision.
   * @param request - preview identity and row selection.
   * @returns committed revision and row outcomes.
   */
  @Remote('import.commit')
  async commitImport(request: SeatRequestMap['seats/import.commit']['params']): Promise<SeatRequestMap['seats/import.commit']['result']> {
    return (await this.scoped()).commitImport(decodeSeatRequest('seats/import.commit', request))
  }
  /** Transfer editing authority only with independent authorization.
   * @param request - observed revision and authorization reference.
   * @returns committed revision or refusal.
   */
  @Remote
  async setAuthority(request: SeatRequestMap['seats/setAuthority']['params']): Promise<SeatRequestMap['seats/setAuthority']['result']> {
    return (await this.scoped()).setAuthority(decodeSeatRequest('seats/setAuthority', request))
  }
  /** Record all report fields without asserting runtime idleness.
   * @param request - report and stable operation identity.
   * @returns committed report version.
   */
  @Remote('report.submit')
  async submitReport(request: SeatRequestMap['seats/report.submit']['params']): Promise<SeatRequestMap['seats/report.submit']['result']> {
    return (await this.scoped()).submitReport(decodeSeatRequest('seats/report.submit', request))
  }
  /** Register observations without blocking on task completion.
   * @param request - explicit objects and registration identity.
   * @returns committed wait state.
   */
  @Remote('wait.register')
  async registerWait(request: SeatRequestMap['seats/wait.register']['params']): Promise<SeatRequestMap['seats/wait.register']['result']> {
    return (await this.scoped()).registerWait(decodeSeatRequest('seats/wait.register', request))
  }
  /** Cancel observation without cancelling underlying tasks.
   * @param request - wait identity and observed version.
   * @returns committed wait state.
   */
  @Remote('wait.cancel')
  async cancelWait(request: SeatRequestMap['seats/wait.cancel']['params']): Promise<SeatRequestMap['seats/wait.cancel']['result']> {
    return (await this.scoped()).cancelWait(decodeSeatRequest('seats/wait.cancel', request))
  }

  /** List owner-authorized runtime evidence.
   * @param request - local filters.
   * @returns window page including unopened seats.
   */
  @Remote
  async list(request: SeatRequestMap['seats/list']['params']): Promise<SeatRequestMap['seats/list']['result']> {
    const service = await this.scoped()
    return service.list(decodeSeatRequest('seats/list', request))
  }
  /** Open through the shared provider, forcing remote automatic opening.
   * @param request - seat and retained operation identity.
   * @returns provider result without waiting for the first model response.
   */
  @Remote
  async open(request: SeatRequestMap['seats/open']['params']): Promise<SeatRequestMap['seats/open']['result']> {
    const service = await this.scoped()
    return service.open({ ...decodeSeatRequest('seats/open', request), origin: 'remote', openingMode: 'auto' })
  }
  /** Open an explicit bounded list without wildcard expansion.
   * @param request - names and operation identity.
   * @returns independent provider outcomes.
   */
  @Remote
  async openBatch(request: SeatRequestMap['seats/openBatch']['params']): Promise<SeatRequestMap['seats/openBatch']['result']> {
    const service = await this.scoped()
    return service.openBatch({ ...decodeSeatRequest('seats/openBatch', request), origin: 'remote', openingMode: 'auto' })
  }
  /** Renew once without conversation text.
   * @param request - local session and stable operation.
   * @returns maintenance evidence.
   */
  @Remote
  async renew(request: SeatRequestMap['seats/renew']['params']): Promise<SeatRequestMap['seats/renew']['result']> {
    return (await this.scoped()).renew(decodeSeatRequest('seats/renew', request))
  }
  /** Close only at the observed idle version.
   * @param request - local session and version.
   * @returns closed or busy evidence.
   */
  @Remote
  async close(request: SeatRequestMap['seats/close']['params']): Promise<SeatRequestMap['seats/close']['result']> {
    return (await this.scoped()).close(decodeSeatRequest('seats/close', request))
  }
  /** Start a recoverable replacement without closing old first.
   * @param request - old session and stable operation.
   * @returns replacement progress.
   */
  @Remote
  async replace(request: SeatRequestMap['seats/replace']['params']): Promise<SeatRequestMap['seats/replace']['result']> {
    return (await this.scoped()).replace(decodeSeatRequest('seats/replace', request))
  }
  /** Preserve upstream user-title pinning.
   * @param request - explicit title and local session.
   * @returns committed title.
   */
  @Remote
  async rename(request: SeatRequestMap['seats/rename']['params']): Promise<SeatRequestMap['seats/rename']['result']> {
    return (await this.scoped()).rename(decodeSeatRequest('seats/rename', request))
  }
  /** Deliver the stored wake text or open an unopened seat.
   * @param request - explicit seat and optional session.
   * @returns delivery or open outcome.
   */
  @Remote
  async wake(request: SeatRequestMap['seats/wake']['params']): Promise<SeatRequestMap['seats/wake']['result']> {
    return (await this.scoped()).wake(decodeSeatRequest('seats/wake', request))
  }
  /** Read metadata outside the Session log.
   * @param request - local session.
   * @returns binding or absent metadata.
   */
  @Remote
  async binding(request: SeatRequestMap['seats/binding']['params']): Promise<SeatRequestMap['seats/binding']['result']> {
    return (await this.scoped()).binding(decodeSeatRequest('seats/binding', request))
  }
  /** Observe a pending operation without retrying effects.
   * @param request - operation identity.
   * @returns durable operation state.
   */
  @Remote
  async operation(request: SeatRequestMap['seats/operation']['params']): Promise<SeatRequestMap['seats/operation']['result']> {
    return (await this.scoped()).operation(decodeSeatRequest('seats/operation', request))
  }
  /** Select project policy with revision comparison.
   * @param request - project, mode and observed revision.
   * @returns the durably committed policy.
   */
  @Remote
  async setProjectMode(request: SeatRequestMap['seats/setProjectMode']['params']): Promise<SeatRequestMap['seats/setProjectMode']['result']> {
    await this.scoped()
    return this.engine().setProjectMode(decodeSeatRequest('seats/setProjectMode', request))
  }
  /** Read pending work without admitting it.
   * @param request - page size and filters.
   * @returns a committed queue page.
   */
  @Remote
  async pending(request: SeatRequestMap['seats/pending']['params']): Promise<SeatRequestMap['seats/pending']['result']> {
    await this.scoped()
    return this.engine().pending(decodeSeatRequest('seats/pending', request))
  }
  /** Approve pending work without bypassing admission.
   * @param request - queue item and observed version.
   * @returns the committed approval result.
   */
  @Remote
  async approve(request: SeatRequestMap['seats/approve']['params']): Promise<SeatRequestMap['seats/approve']['result']> {
    await this.scoped()
    return this.engine().approve(decodeSeatRequest('seats/approve', request))
  }
  /** Cancel pending work without closing a window.
   * @param request - queue item and observed version.
   * @returns the committed cancellation result.
   */
  @Remote
  async cancel(request: SeatRequestMap['seats/cancel']['params']): Promise<SeatRequestMap['seats/cancel']['result']> {
    await this.scoped()
    return this.engine().cancel(decodeSeatRequest('seats/cancel', request))
  }
  /** Read committed gate state.
   * @param request - gate filters and cursor.
   * @returns a gate state page.
   */
  @Remote
  async gates(request: SeatRequestMap['seats/gates']['params']): Promise<SeatRequestMap['seats/gates']['result']> {
    await this.scoped()
    const gates = this.ctx.get('seatGates')
    if (!gates) throw new RemoteError('seat/unavailable', 'Seat gates are unavailable', {})
    return gates.list(decodeSeatRequest('seats/gates', request))
  }
  /** Read local node state without activating providers.
   * @param request - empty parameter object.
   * @returns the node alias and capacity.
   */
  @Remote
  async nodeStatus(request: SeatRequestMap['seats/nodeStatus']['params']): Promise<SeatRequestMap['seats/nodeStatus']['result']> {
    await this.scoped()
    decodeSeatRequest('seats/nodeStatus', request)
    return this.engine().nodeStatus()
  }
}

export default SeatRemote
