/** Owner-authorized profile editor adapter over the existing local catalog. */
import type { Context } from '@panedesk/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type * as T from '@panedesk/dsh-seat'
import type { SeatProfileAccess } from '@panedesk/dsh-seat-local'
import type { RemoveSeatProfileRequest, SeatProfileSnapshot } from './types.ts'

declare module '@panedesk/cordis' {
  interface Context { seatProfiles: SeatProfiles }
}

/** Remote profile operations do not accept authority from their request bodies. */
export default class SeatProfiles extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'seatProfiles', { namespace: 'seatProfiles' }) }
  private access(): SeatProfileAccess {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner' || this.ctx.invocation.signal.aborted) {
      throw new RemoteError('seat-profiles/unauthorized', 'Authenticated owner required', {})
    }
    const access = this.ctx.get('seatProfilesLocal')
    if (!access) throw new RemoteError('seat-profiles/unavailable', 'Local profile provider is unavailable', {})
    return access
  }
  /** Read the catalog, actual opening history and deletion impact.
   * @param signal - Resource or caller cancellation.
   * @returns Complete local observations or an explicit failure.
   */
  @Remote
  async read(signal?: AbortSignal): Promise<SeatProfileSnapshot> {
    const access = this.access()
    signal?.throwIfAborted()
    const value = await access.read()
    signal?.throwIfAborted()
    return value
  }
  /** Transfer source-owned editing only after explicit owner confirmation.
   * @param request - Observed revision and affirmative confirmation.
   * @returns Existing audited authority mutation receipt or refusal.
   */
  @Remote
  takeover(request: { expectedRevision: number; operationId: T.SeatOperationId; confirmed: true }): Promise<T.SeatCatalogMutationResult> {
    return this.access().takeover(request)
  }
  /** Save an edited definition without overwriting a changed catalog.
   * @param request - Observed catalog revision and next definition revision.
   * @returns Existing catalog mutation receipt or refusal.
   */
  @Remote
  save(request: {
    definitionJson: string
    expectedRevision: number
    operationId: T.SeatOperationId
  }): Promise<T.SeatCatalogMutationResult> {
    const access = this.access()
    let definition: unknown
    try { definition = JSON.parse(request.definitionJson) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return Promise.resolve({ status: 'rejected', error: { code: 'invalid-definition', message: 'Definition JSON is invalid.',
        alternative: 'Correct the JSON fields and preview the definition again.', retryable: false, effectState: 'none' } })
    }
    return access.save({ definition, expectedRevision: request.expectedRevision, operationId: request.operationId })
  }
  /** Delete only after the owner confirms observed windows and approvals.
   * @param request - Confirmed impact and catalog CAS revision.
   * @returns Catalog mutation receipt; windows and approvals are retained.
   */
  @Remote
  deleteProfile(request: RemoveSeatProfileRequest): Promise<T.SeatCatalogMutationResult> { return this.access().remove(request) }
  /** Preview a generic mapped Markdown or CSV table without changing the catalog.
   * @param request - Existing source, mapping and explicit defaults.
   * @returns Original row diagnostics and selectable actions.
   */
  @Remote
  preview(request: T.PreviewSeatImportRequest): Promise<T.SeatImportPlan | T.SeatRejected> { return this.access().preview(request) }
  /** Commit only selected rows of a current preview.
   * @param request - Stable preview identity, selections and observed revision.
   * @returns Existing import receipt or refusal.
   */
  @Remote
  commit(request: T.CommitSeatImportRequest): Promise<T.CommitSeatImportResult> { return this.access().commit(request) }
}

declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'seat-profiles/unauthorized': Record<string, never>
    'seat-profiles/unavailable': Record<string, never>
  }
}
