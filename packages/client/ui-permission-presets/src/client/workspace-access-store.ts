/** Owner settings controller for native Windows workspace authorizations. */
import type { Context } from '@panedesk/cordis'
import type { ConnectionHandle } from '@panedesk/dsh-client-connection/client'
import type {} from '@panedesk/dsh-api-remotes/client'
import { createSnapshotStore } from '@panedesk/dsh-client-store'
import type { WorkspaceWriteEntry } from '@panedesk/dsh-permission-presets/client'

/** Complete visible authorization list and the currently pending operation. */
export interface WorkspaceAccessState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  supported: boolean
  entries: WorkspaceWriteEntry[]
  error: string | null
}

/** Serializes UI mutations and discards settlements from replaced connections or disposed rows. */
export class WorkspaceAccessController {
  /** Current inventory and operation state for the settings row. */
  readonly store = createSnapshotStore<WorkspaceAccessState>({ status: 'idle', supported: false, entries: [], error: null })
  private disposed = false
  private pending: object | undefined
  private readonly connection: ConnectionHandle
  private readonly unsubscribe: () => void

  constructor(private readonly ctx: Context) {
    this.connection = ctx.get('connection') as ConnectionHandle
    let generation = this.connection.generation.getSnapshot()
    this.unsubscribe = this.connection.generation.subscribe(() => {
      const next = this.connection.generation.getSnapshot()
      if (this.disposed || next === generation) return
      generation = next
      this.pending = undefined
      this.store.set({ status: 'idle', supported: false, entries: [], error: null })
    })
  }

  /** Refresh the complete owner inventory. */
  async load(): Promise<void> {
    await this.perform(false, async () => {})
  }

  /** Ask the native directory picker before recording settings consent. */
  async selectDirectory(): Promise<void> {
    await this.perform(true, async (current) => {
      const picker = this.ctx.remote.directoryPicker
      const selected = await picker.pick()
      if (!current()) return
      if (!selected.ok) throw new Error(selected.error.message)
      if (selected.value === null) return
      const result = await this.ctx.remote.permissionPresets.authorizeWorkspaceWrite(selected.value)
      if (!result.ok) throw new Error(result.error.message)
    })
  }

  /**
   * Remove one native capability and its durable record.
   * @param workspace - Canonical directory returned by the host inventory.
   */
  async revoke(workspace: string): Promise<void> {
    await this.perform(true, async () => {
      const result = await this.ctx.remote.permissionPresets.revokeWorkspaceWrite(workspace)
      if (!result.ok) throw new Error(result.error.message)
    })
  }

  /** Prevent late completions from publishing after plugin disposal. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
  }

  private async perform(mutation: boolean, operation: (current: () => boolean) => Promise<void>): Promise<void> {
    if (this.disposed || this.pending !== undefined) return
    const generation = this.connection.generation.getSnapshot()
    if (generation === undefined) {
      this.store.set({ status: 'error', supported: false, entries: [], error: 'No active Host connection' })
      return
    }
    const pending = {}
    this.pending = pending
    this.store.update((state) => { state.status = mutation ? 'saving' : 'loading'; state.error = null })
    const current = (): boolean => !this.disposed && this.connection.generation.getSnapshot() === generation
    try {
      await operation(current)
      if (!current()) return
      const result = await this.ctx.remote.permissionPresets.workspaceWriteAccess()
      if (!current()) return
      if (!result.ok) throw new Error(result.error.message)
      this.store.set({ ...result.value, status: 'ready', error: null })
    } catch (error) {
      if (current()) this.store.update((state) => { state.status = 'error'; state.error = error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }
}
