/** Owner-visible paths and engine observations, independent of first-entry guidance. */
import { createSnapshotStore } from '@panedesk/dsh-client-store'
import type { TypertClientRemote } from '@panedesk/dsh-typert-protocol'

type OpeningRemote = TypertClientRemote['projectOpening']
type Inspection = Extract<Awaited<ReturnType<OpeningRemote['inspect']>>, { ok: true }>['value']

/** One settings-page observation; failed reads retain the last answer but are never shown as current. */
export interface OpeningInspection {
  status: 'loading' | 'ready' | 'error'
  value?: Inspection
}

/** Page-owned metadata reads; native path actions keep their own visible outcome. */
export class ProjectSettingsController {
  readonly state = createSnapshotStore<OpeningInspection>({ status: 'loading' })
  private generation = 0
  private closed = false

  constructor(private readonly opening: OpeningRemote, private readonly session: TypertClientRemote['session']) {}

  /** Stop publication after the client plugin unloads. */
  dispose(): void { this.closed = true; ++this.generation }

  /** Refresh paths and engine state; failure leaves an explicit retryable observation.
   * @returns Settlement after publication, unless superseded or disposed.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.state.set({ ...this.state.getSnapshot(), status: 'loading' })
    try {
      const response = await this.opening.inspect()
      if (this.closed || generation !== this.generation) return
      if (!response.ok) { this.state.set({ ...this.state.getSnapshot(), status: 'error' }); return }
      this.state.set({ status: 'ready', value: response.value })
    } catch (_error) {
      // The settings page owns retry; this read cannot change project preferences.
      if (!this.closed && generation === this.generation) this.state.set({ ...this.state.getSnapshot(), status: 'error' })
    }
  }

  /** Use the existing Host desktop action, without borrowing a Session.
   * @param path Absolute Host path reported by inspection.
   * @param action Open the file or reveal it in its containing directory.
   * @returns Whether the native action was acknowledged; the initiating page reports refusal.
   */
  async openPath(path: string, action: 'open' | 'reveal'): Promise<boolean> {
    try { return (await this.session.openWorkspacePath({ path, ...(action === 'reveal' ? { action } : {}) })).ok }
    catch (_error) {
      // Carrier failures and native refusals both leave the displayed path available for retry.
      return false
    }
  }
}
