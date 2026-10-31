/** Product-settings projection and revision-fenced workspace selections. */
import { createSnapshotStore } from '@panedesk/dsh-client-store'
import type { JsonValue } from '@panedesk/dsh-util-values'
import type { SettingsDescribeValue, SettingsNamespaceView } from '@panedesk/dsh-settings/types'
import type { ProjectSelection } from '../types.ts'

interface Reply<T> {
  ok: boolean
  value?: T
  error?: { message: string; code?: string; details?: object }
}

/** Only the settings operations this feature needs. */
export interface SettingsPort {
  describe(): Promise<Reply<SettingsDescribeValue>>
  select(path: string, selection: ProjectSelection, revision: number): Promise<Reply<SettingsNamespaceView>>
}

/** Renderer-visible product preference state. */
export interface ProjectPreferences {
  status: 'loading' | 'ready' | 'saving' | 'error'
  writable: boolean
  projects: Readonly<Record<string, ProjectSelection>>
  revision: number
  error: boolean
  saved: boolean
  compensation?: readonly { projectId: string; status: 'restored' | 'conflict' | 'failed' }[]
}

function compensation(error: Reply<never>['error']): ProjectPreferences['compensation'] {
  if (error?.code !== 'project-opening/compensation') return undefined
  const details = error.details
  if (!details || !('outcomes' in details) || !Array.isArray(details.outcomes)) return undefined
  return details.outcomes.flatMap((outcome: unknown) => {
    if (!outcome || typeof outcome !== 'object' || !('projectId' in outcome) || typeof outcome.projectId !== 'string'
      || !('status' in outcome) || (outcome.status !== 'restored' && outcome.status !== 'conflict' && outcome.status !== 'failed')) return []
    return [{ projectId: outcome.projectId, status: outcome.status }]
  })
}

function selections(value: JsonValue): Record<string, ProjectSelection> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project settings')
  const projects = value.projects
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) throw new Error('Invalid project selections')
  const result: Record<string, ProjectSelection> = {}
  for (const [path, selection] of Object.entries(projects)) {
    if (selection === null || typeof selection !== 'object' || Array.isArray(selection)
      || typeof selection.chosen !== 'boolean') {
      throw new Error('Invalid project selection')
    }
    const mode = selection.mode
    if (mode !== 'off' && mode !== 'remind' && mode !== 'auto') throw new Error('Invalid opening mode')
    Object.defineProperty(result, path, { value: { mode, chosen: selection.chosen }, enumerable: true })
  }
  return result
}

/** Owns one client projection; only successful settings writes mark a project chosen. */
export class ProjectPreferencesController {
  /** Observable projection of durable preferences and the current save state. */
  readonly state = createSnapshotStore<ProjectPreferences>({
    status: 'loading', writable: false, projects: {}, revision: 0, error: false, saved: false,
  })

  private generation = 0
  private closed = false
  private reloadPending = false

  private isClosed(): boolean { return this.closed }

  constructor(private readonly port: SettingsPort) {}

  /** Stop publishing responses after the plugin is disposed. */
  dispose(): void { this.closed = true; this.generation += 1 }

  /** Read current authoritative preferences, retaining an actionable failure state.
   * @returns Completion of this read; stale responses never replace newer data.
   */
  async load(): Promise<void> {
    if (this.isClosed()) return
    if (this.state.getSnapshot().status === 'saving') { this.reloadPending = true; return }
    const generation = ++this.generation
    this.state.set({ ...this.state.getSnapshot(), status: 'loading', error: false })
    try {
      const response = await this.port.describe()
      if (this.isClosed() || generation !== this.generation) return
      const namespace = response.value?.namespaces.find(item => item.ns === 'ui-project-onboarding')
      if (!response.ok || namespace === undefined || response.value === undefined) throw new Error('Settings unavailable')
      this.state.set({ status: 'ready', writable: response.value.writable,
        projects: selections(namespace.value), revision: namespace.revision, error: false, saved: false })
    } catch (error) {
      // Wire failures and invalid durable data share a localized retry action.
      if (this.isClosed() || generation !== this.generation) return
      void error
      this.state.set({ ...this.state.getSnapshot(), status: 'error', error: true })
    }
  }

  /** Persist a selected mode for exactly one workspace path.
   * @param path Workspace directory, used verbatim as one dictionary key.
   * @param mode Explicit human selection; remind is the initial default.
   * @returns Whether the authoritative write succeeded.
   */
  async select(path: string, mode: ProjectSelection['mode']): Promise<boolean> {
    const before = this.state.getSnapshot()
    if (this.isClosed() || !before.writable || before.status !== 'ready' || path.length === 0) return false
    ++this.generation
    const { compensation: _previousCompensation, ...retained } = before
    this.state.set({ ...retained, status: 'saving', error: false, saved: false })
    let outcomes: ProjectPreferences['compensation']
    try {
      const response = await this.port.select(path, { mode, chosen: true }, before.revision)
      if (this.isClosed()) return false
      outcomes = compensation(response.error)
      if (!response.ok || response.value === undefined) throw new Error('Settings write refused')
      this.state.set({ ...retained, status: 'ready', projects: selections(response.value.value),
        revision: response.value.revision, error: false, saved: true })
      return true
    } catch (error) {
      // Keep the prior committed choice; a refused write must not dismiss first-entry guidance.
      if (this.isClosed()) return false
      void error
      this.state.set({ ...retained, status: 'ready', error: true, saved: false,
        ...(outcomes ? { compensation: outcomes } : {}) })
      return false
    } finally {
      if (this.reloadPending && !this.isClosed()) { this.reloadPending = false; await this.load() }
    }
  }
}
