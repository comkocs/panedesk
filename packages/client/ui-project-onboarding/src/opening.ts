/** Owner-authorized persistence and engine application of workspace opening modes. */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@panedesk/dsh-agent'
import type {} from '@panedesk/dsh-session-title'
import type {} from '@panedesk/dsh-workspace'
import type { Config } from './index.ts'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type {} from '@panedesk/dsh-config-editor'
import type { Context } from '@panedesk/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type { SeatCallContext, SeatProjectId, SeatOperationId, SeatProjectPolicy } from '@panedesk/dsh-seat'
import type { SettingsNamespaceView } from '@panedesk/dsh-settings/types'
import type { JsonValue } from '@panedesk/dsh-util-values'

declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'project-opening/unauthorized': Record<string, never>
    'project-opening/compensation': { outcomes: { projectId: SeatProjectId; status: 'restored' | 'conflict' | 'failed' }[] }
  }
}
import type { ProjectSelection } from './types.ts'

declare module '@panedesk/cordis' {
  interface Context {
    /** Owner-only workspace preference operations. */
    projectOpening: ProjectOpening
  }
}

/** Feature-local remote operations; no model or window is started here. */
export default class ProjectOpening extends TypertRemoteService {
  static inject = ['settings', 'sessionTitle', 'workspaceRegistry']

  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<unknown>>()

  constructor(ctx: Context, private readonly preferences: Config) {
    super(ctx, 'projectOpening')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.active])
    })
  }

  /** Apply the selected preset's title without starting a turn.
   * @param agent - exact session receiving the opening draft.
   * @param index - saved preset position.
   * @returns Completion of the title append.
   */
  @Remote
  async selectPreset(agent: Agent, index: number): Promise<void> {
    const preset = this.preferences.openingPresets.get()[index]!
    await this.ctx.sessionTitle.selectOpeningPreset(agent.session, preset.name)
  }

  /** Read the folder written in each sentence; a sentence without one stays empty.
   * @param prompts - opening sentences, unchanged.
   * @returns Each sentence's own folder, or an empty string when it names no path.
   */
  @Remote
  inferDirectories(prompts: string[]): string[] {
    return prompts.map(prompt => {
      const token = (prompt.match(/"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|[A-Za-z]:\\[^\s"'`，。；！？<>]+|\/[^\s"'`，。；！？<>]+/u) ?? [])[0]
      if (!token) return ''
      const path = token.replace(/^["'`]|["'`]$/gu, '').replace(/[,.!?;:）)\]】]+$/u, '')
      const separator = path.includes('\\') ? '\\' : '/'
      const end = path.replace(/[\\/]+$/u, '').lastIndexOf(separator)
      const folder = end > 0 ? path.slice(0, end) : path
      return folder === '' || /^[A-Za-z]:$/u.test(folder) ? '' : folder
    })
  }

  /** Read owner-visible storage locations and current engine availability without starting it.
   * @returns Absolute profile and JSON catalog paths; null means the local provider is absent or uses another backend.
   */
  @Remote
  async inspect(): Promise<{ settingsFile: string; settingsDirectory: string; catalogFile: string | null; catalogDirectory: string | null; engine: 'running' | 'recovering' | 'unavailable' }> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('project-opening/unauthorized', 'Authenticated owner required', {})
    }
    const entries = this.ctx.get('configEditor')?.entries() ?? []
    const configOf = (name: string): unknown => entries.find(entry => !entry.disabled && entry.options.name === name)?.fiber?.config
    const domain = z.object({ backend: z.string(), routes: z.record(z.string(), z.string()).optional() })
      .safeParse(configOf('@panedesk/dsh-storage-domain'))
    const json = z.object({ root: z.string() }).safeParse(configOf('@panedesk/dsh-storage-json'))
    const backend = domain.success ? domain.data.routes?.seat_catalog ?? domain.data.backend : undefined
    const engine = this.ctx.get('seatEngine')
    const settingsFile = resolve(this.ctx.settings.documentPath)
    const catalogDirectory = this.ctx.get('seats') && backend === 'json' && json.success ? resolve(json.data.root) : null
    return {
      settingsFile, settingsDirectory: dirname(settingsFile),
      catalogFile: catalogDirectory === null ? null : join(catalogDirectory, 'seat_catalog.json'), catalogDirectory,
      engine: engine ? (await engine.nodeStatus()).engine : 'unavailable',
    }
  }

  /** Persist one explicit human selection and apply it to matching local seat projects.
   * @param path Absolute workspace directory, never a project file to write.
   * @param selection Human-selected mode and confirmation marker.
   * @param revision Observed product-settings revision.
   * @returns Committed product namespace after engine application succeeds.
   */
  @Remote
  async select(path: string, selection: ProjectSelection, revision: number): Promise<SettingsNamespaceView> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('project-opening/unauthorized', 'Authenticated owner required', {})
    }
    const signal = this.ctx.invocation.signal
    const check = () => {
      if (signal.aborted || this.lifetime.signal.aborted) throw new RemoteError('gateway/internal', 'Project selection was cancelled', {})
    }
    check()
    const operation = this.save(path, selection, revision, check)
    this.active.add(operation)
    try { return await operation } finally { this.active.delete(operation) }
  }

  private async save(path: string, selection: ProjectSelection, revision: number, check: () => void): Promise<SettingsNamespaceView> {
    if (resolve(path) !== path || !selection.chosen || !['off', 'remind', 'auto'].includes(selection.mode)) {
      throw new RemoteError('gateway/internal', 'Invalid workspace selection', {})
    }
    const settings = this.ctx.settings
    if (!settings.writable) throw new RemoteError('project-opening/unauthorized', 'Product settings are read-only', {})
    const before = settings.describe().find(item => item.ns === 'ui-project-onboarding')
    if (!before || before.revision !== revision) throw new RemoteError('gateway/internal', 'Project settings changed; reload before saving', {})
    const engine = this.ctx.get('seatEngine'), seats = this.ctx.get('seats')
    const projectIds = new Set<SeatProjectId>()
    if (engine && seats) {
      const node = await engine.nodeStatus()
      check()
      const service = seats.withAuthority({ principalId: 'owner' as SeatCallContext['principalId'], origin: 'manual', nodeId: node.nodeId })
      let cursor: string | undefined
      for (;;) {
        const page = await service.definitions(cursor === undefined ? {} : { cursor })
        check()
        for (const definition of page.definitions) {
          if (definition.directories.some(directory => resolve(directory.path) === path)) projectIds.add(definition.projectId)
        }
        if (page.complete) break
        if (!page.nextCursor || page.nextCursor === cursor) throw new RemoteError('gateway/internal', 'Seat catalog is incomplete', {})
        cursor = page.nextCursor
      }
    }
    const previous: SeatProjectPolicy[] = []
    try {
      if (engine) for (const projectId of projectIds) {
        const policy = await engine.projectPolicy(projectId)
        check()
        const result = await engine.setProjectMode({ projectId, mode: selection.mode,
          expectedRevision: policy.revision, operationId: randomUUID() as SeatOperationId })
        if (result.status !== 'saved') throw new Error('Opening policy changed; reload before saving')
        previous.push(policy)
      }
      check()
      await settings.mutate('ui-project-onboarding', [{ op: 'set', path: ['projects', path], value: { mode: selection.mode, chosen: true } }], revision)
    } catch (error) {
      const outcomes: { projectId: SeatProjectId; status: 'restored' | 'conflict' | 'failed' }[] = []
      if (engine) for (const policy of previous.reverse()) {
        try {
          const restored = await engine.resetProjectMode({ projectId: policy.projectId, mode: policy.mode,
            modeChosen: policy.modeChosen, expectedRevision: policy.revision + 1, operationId: randomUUID() as SeatOperationId })
          if (restored.status === 'saved') outcomes.push({ projectId: policy.projectId, status: 'restored' })
          else if (restored.error.code === 'revision-conflict') {
            const current = await engine.projectPolicy(policy.projectId)
            outcomes.push({ projectId: policy.projectId,
              status: current.mode === policy.mode && current.modeChosen === policy.modeChosen ? 'restored' : 'conflict' })
          } else outcomes.push({ projectId: policy.projectId, status: 'failed' })
        } catch (_restoreError) {
          // An unknown write outcome needs review; it must not prevent other independent restorations.
          outcomes.push({ projectId: policy.projectId, status: 'failed' })
        }
      }
      if (outcomes.length) throw new RemoteError('project-opening/compensation',
        'Project settings were not saved; review each policy restoration before retrying', { outcomes }, { cause: error })
      throw error
    }
    const committed = settings.describe({ redactSecrets: true }).find(item => item.ns === 'ui-project-onboarding')
    if (!committed) throw new RemoteError('gateway/internal', 'Project settings are unavailable after save', {})
    return { ns: String(committed.ns), autoGenerate: committed.autoGenerate,
      schema: committed.schema as JsonValue, value: committed.value as JsonValue,
      applies: committed.applies, secrets: committed.secrets ?? [], revision: committed.revision }
  }
}
