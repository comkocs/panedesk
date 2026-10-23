/** Typed seat requests use the same decoder as the receiving SDK adapter. */
import { decodeSeatRequest, decodeSeatResult } from '@panedesk/dsh-sdk-protocol'
import type { SeatRequestMap } from '@panedesk/dsh-sdk-protocol'

/** Transport-neutral facade; retries retain caller-owned operation identities. */
export class SeatsClient {
  constructor(private readonly request: (method: string, params: object) => Promise<unknown>) {}

  private async call<M extends keyof SeatRequestMap>(method: M, params: SeatRequestMap[M]['params']): Promise<SeatRequestMap[M]['result']> {
    const validated = decodeSeatRequest(method, params)
    return decodeSeatResult(method, await this.request(method, validated))
  }

  /** Preview source rows without changing the catalog.
   * @param request - source, mapping and explicit defaults.
   * @returns revision-bound row comparisons.
   */
  previewImport(request: SeatRequestMap['seats/import.preview']['params']): Promise<SeatRequestMap['seats/import.preview']['result']> { return this.call('seats/import.preview', request) }
  /** Commit only selected preview rows.
   * @param request - preview identity and observed revision.
   * @returns committed revision and per-row outcomes.
   */
  commitImport(request: SeatRequestMap['seats/import.commit']['params']): Promise<SeatRequestMap['seats/import.commit']['result']> { return this.call('seats/import.commit', request) }
  /** Transfer editing authority with external authorization.
   * @param request - authorization reference and observed revision.
   * @returns committed revision or refusal.
   */
  setAuthority(request: SeatRequestMap['seats/setAuthority']['params']): Promise<SeatRequestMap['seats/setAuthority']['result']> { return this.call('seats/setAuthority', request) }
  /** Record a report without treating it as runtime evidence.
   * @param request - complete report and operation identity.
   * @returns committed report version.
   */
  submitReport(request: SeatRequestMap['seats/report.submit']['params']): Promise<SeatRequestMap['seats/report.submit']['result']> { return this.call('seats/report.submit', request) }
  /** Register observations without waiting for tasks to finish.
   * @param request - explicit objects and stable registration identity.
   * @returns committed registration.
   */
  registerWait(request: SeatRequestMap['seats/wait.register']['params']): Promise<SeatRequestMap['seats/wait.register']['result']> { return this.call('seats/wait.register', request) }
  /** Cancel observation without cancelling underlying tasks.
   * @param request - wait identity and observed version.
   * @returns committed wait state.
   */
  cancelWait(request: SeatRequestMap['seats/wait.cancel']['params']): Promise<SeatRequestMap['seats/wait.cancel']['result']> { return this.call('seats/wait.cancel', request) }

  /** List runtime evidence without starting a model turn.
   * @param request - local filters and cursor.
   * @returns the provider's complete or partial page.
   */
  list(request: SeatRequestMap['seats/list']['params']): Promise<SeatRequestMap['seats/list']['result']> { return this.call('seats/list', request) }
  /** Open an exact definition; remote opening is always automatic.
   * @param request - explicit seat and stable operation identity.
   * @returns creation, queue, candidate or failure facts.
   */
  open(request: Omit<SeatRequestMap['seats/open']['params'], 'origin' | 'openingMode'>): Promise<SeatRequestMap['seats/open']['result']> { return this.call('seats/open', { ...request, origin: 'remote', openingMode: 'auto' }) }
  /** Open only explicitly named seats.
   * @param request - unique bounded names and operation identity.
   * @returns independent per-seat results, never an atomic batch promise.
   */
  openBatch(request: Omit<SeatRequestMap['seats/openBatch']['params'], 'origin' | 'openingMode'>): Promise<SeatRequestMap['seats/openBatch']['result']> { return this.call('seats/openBatch', { ...request, origin: 'remote', openingMode: 'auto' }) }
  /** Renew once without adding conversation text.
   * @param request - session and retained operation identity.
   * @returns cache evidence or an explicit failure.
   */
  renew(request: SeatRequestMap['seats/renew']['params']): Promise<SeatRequestMap['seats/renew']['result']> { return this.call('seats/renew', request) }
  /** Close only an idle window at the observed version.
   * @param request - session, version and operation identity.
   * @returns closed, busy, conflicting or rejected outcome.
   */
  close(request: SeatRequestMap['seats/close']['params']): Promise<SeatRequestMap['seats/close']['result']> { return this.call('seats/close', request) }
  /** Replace without closing the old window first.
   * @param request - old session and operation identity.
   * @returns durable replacement progress.
   */
  replace(request: SeatRequestMap['seats/replace']['params']): Promise<SeatRequestMap['seats/replace']['result']> { return this.call('seats/replace', request) }
  /** Rename with upstream title pinning.
   * @param request - explicit title and session.
   * @returns committed title or rejection.
   */
  rename(request: SeatRequestMap['seats/rename']['params']): Promise<SeatRequestMap['seats/rename']['result']> { return this.call('seats/rename', request) }
  /** Send the stored wake template, or open an unopened seat.
   * @param request - seat and optional explicit session.
   * @returns delivery, opening or choice result.
   */
  wake(request: SeatRequestMap['seats/wake']['params']): Promise<SeatRequestMap['seats/wake']['result']> { return this.call('seats/wake', request) }
  /** Observe a retained operation rather than resubmitting it.
   * @param request - operation identity.
   * @returns missing, pending or settled result.
   */
  operation(request: SeatRequestMap['seats/operation']['params']): Promise<SeatRequestMap['seats/operation']['result']> { return this.call('seats/operation', request) }
  /** Inspect the engine's session metadata without modifying the Session log.
   * @param request - local session identity.
   * @returns binding, absent metadata or rejection.
   */
  binding(request: SeatRequestMap['seats/binding']['params']): Promise<SeatRequestMap['seats/binding']['result']> { return this.call('seats/binding', request) }
  /** Select a project's mode with revision comparison.
   * @param request - policy and stable operation identity.
   * @returns committed policy or rejection.
   */
  setProjectMode(request: SeatRequestMap['seats/setProjectMode']['params']): Promise<SeatRequestMap['seats/setProjectMode']['result']> { return this.call('seats/setProjectMode', request) }
  /** List pending work without exposing source credentials.
   * @param request - bounded filters.
   * @returns page and committed watermark.
   */
  pending(request: SeatRequestMap['seats/pending']['params']): Promise<SeatRequestMap['seats/pending']['result']> { return this.call('seats/pending', request) }
  /** Approve reminder confirmation without bypassing other admission checks.
   * @param request - queue identity and observed version.
   * @returns committed approval or rejection.
   */
  approve(request: SeatRequestMap['seats/approve']['params']): Promise<SeatRequestMap['seats/approve']['result']> { return this.call('seats/approve', request) }
  /** Cancel unopened work without closing a window.
   * @param request - queue identity and observed version.
   * @returns committed cancellation or rejection.
   */
  cancel(request: SeatRequestMap['seats/cancel']['params']): Promise<SeatRequestMap['seats/cancel']['result']> { return this.call('seats/cancel', request) }
  /** Read committed gate counts.
   * @param request - bounded gate filters.
   * @returns gate page and watermark.
   */
  gates(request: SeatRequestMap['seats/gates']['params']): Promise<SeatRequestMap['seats/gates']['result']> { return this.call('seats/gates', request) }
  /** Inspect local engine capacity.
   * @returns node alias, availability and configured capacity.
   */
  nodeStatus(): Promise<SeatRequestMap['seats/nodeStatus']['result']> { return this.call('seats/nodeStatus', {}) }
}
