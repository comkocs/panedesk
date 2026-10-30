/** Owner-only manual seat UI adapter; all window configuration remains in SeatService. */
import type { Context } from '@panedesk/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type { SeatCallContext, SeatService } from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { PreviewSeatImportRequest, SeatDefinition } from '@panedesk/dsh-seat/types'
import type { SeatAddRequest, SeatOverview, SeatUiOpenRequest, SeatUiOpenResult } from './types.ts'

/** Product-owned home; omission leaves source preparation unavailable. */
export interface Config {
  /** Absolute product home containing private import sources; omission disables preparation. */
  home?: string
}

const addRequest = z.object({ name: z.string().trim().min(1), directory: z.string().min(1),
  provider: z.string().min(1), model: z.string().min(1), opening: z.string().trim().min(1),
  reasoningEffort: z.string().min(1).optional() }).strict()

function csvCell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return `"${text.replaceAll('"', '""')}"`
}

function sourceValues(definition: SeatDefinition): Record<string, unknown> {
  const { source: _source, revision: _revision, ...values } = definition
  return values
}

declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'seat-ui/unauthorized': Record<string, never>
    'seat-ui/name-exists': Record<string, never>
    'seat-ui/directory-invalid': Record<string, never>
    'seat-ui/unavailable': Record<string, never>
  }
}

/** Host service for the generated seatUi namespace. */
export default class SeatUi extends TypertRemoteService {
  constructor(ctx: Context, private readonly config: Config = {}) { super(ctx, 'seatUi', { namespace: 'seatUi' }) }

  /** Prepare a complete host-owned source snapshot without changing the seat catalog.
   * @param request - Four form values and the configured provider/model selection, never a source path.
   * @returns Existing import request; callers preview it and commit only its single create row.
   */
  @Remote
  async prepareAdd(request: SeatAddRequest): Promise<PreviewSeatImportRequest> {
    const service = await this.service()
    if (!service) throw new RemoteError('seat-ui/unavailable', 'Seat providers are unavailable', {})
    const parsed = addRequest.parse(request)
    if (!this.config.home || !isAbsolute(this.config.home)) throw new Error('Seat import home is unavailable')
    const catalog = await this.overview()
    if (!catalog.complete) throw new Error('Seat catalog is incomplete')
    if (catalog.definitions.some(definition => definition.seat === parsed.name)) {
      throw new RemoteError('seat-ui/name-exists', 'Seat name already exists', {})
    }
    if (!isAbsolute(parsed.directory)) throw new RemoteError('seat-ui/directory-invalid', 'Working directory must be absolute', {})
    let directory
    try { directory = await stat(parsed.directory) }
    catch (_error) { throw new RemoteError('seat-ui/directory-invalid', 'Working directory does not exist or is not accessible', {}) }
    if (!directory.isDirectory()) throw new RemoteError('seat-ui/directory-invalid', 'Working directory is not a directory', {})
    const engine = this.ctx.get('seatEngine')
    if (!engine) throw new RemoteError('seat-ui/unavailable', 'Seat providers are unavailable', {})
    const node = await engine.nodeStatus()
    const defaults: Partial<SeatDefinition> = {
      platform: 'server', node: node.nodeName, projectId: `seat:${parsed.name}` as SeatDefinition['projectId'],
      directories: [{ path: parsed.directory, startup: true }], opening: { kind: 'text', text: parsed.opening },
      agentPreset: 'standard', permissionPreset: 'workspace-write', provider: parsed.provider, model: parsed.model,
      reasoningEffort: parsed.reasoningEffort ?? 'off', autoKeepAlive: false,
      worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 },
    }
    const home = await realpath(this.config.home)
    let parent = home
    for (const segment of ['seats', 'imports']) {
      parent = join(parent, segment)
      try { await mkdir(parent, { mode: 0o700 }) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
      const entry = await lstat(parent)
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Seat import directory must remain inside home')
    }
    const values = [...catalog.definitions.map(sourceValues), { ...defaults, seat: parsed.name }]
    const columns = [...new Set(values.flatMap(value => Object.keys(value)))]
    const content = `${columns.map(csvCell).join(',')}\n${values.map(value => columns.map(column =>
      csvCell(value[column] ?? '')).join(',')).join('\n')}\n`
    const sourcePath = join(parent, `${randomUUID()}.csv`)
    const temporary = `${sourcePath}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(content, 'utf8')
      await file.sync()
      await file.close()
      await rename(temporary, sourcePath)
    } catch (error) {
      await file.close()
      await rm(temporary, { force: true })
      throw error
    }
    return { format: 'csv', sourcePath, columnMap: Object.fromEntries(columns.map(column => [column, column])), defaults: {} }
  }

  private async service(): Promise<SeatService | undefined> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('seat-ui/unauthorized', 'Seat UI requires the authenticated owner.', {})
    }
    const seats = this.ctx.get('seats')
    const engine = this.ctx.get('seatEngine')
    if (!seats || !engine) return undefined
    const node = await engine.nodeStatus()
    return seats.withAuthority({ principalId: 'owner' as SeatCallContext['principalId'], origin: 'manual', nodeId: node.nodeId })
  }

  /** Read the complete local catalog and existing-window status without starting a runtime.
   * @param sessionId - Optional occurrence whose exact binding is read instead of inferred from the window list.
   * @param signal - Caller cancellation when the resource or plugin is released.
   * @returns Authorized seat definitions and their current windows, or explicit unavailability.
   */
  @Remote
  async overview(sessionId?: SessionId, signal?: AbortSignal): Promise<SeatOverview> {
    signal?.throwIfAborted()
    const service = await this.service()
    if (!service) return { available: false, definitions: [], windows: [], complete: true }
    const readIdentity = async (): Promise<Pick<SeatOverview, 'binding' | 'identityStatus'>> => {
      if (sessionId === undefined) return {}
      try { return { binding: await service.binding({ sessionId }) } }
      catch (_error) {
        signal?.throwIfAborted()
        // Identity failures must not prevent independent catalog and online reads.
        return { identityStatus: 'failed' }
      }
    }
    const readCatalog = async (): Promise<Omit<SeatOverview, 'binding' | 'identityStatus'>> => {
      const definitions: SeatOverview['definitions'][number][] = []
      try {
        let cursor: string | undefined
        for (;;) {
          signal?.throwIfAborted()
          const page = await service.definitions(cursor === undefined ? {} : { cursor })
          definitions.push(...page.definitions)
          if (page.complete) break
          if (page.nextCursor === undefined || page.nextCursor === cursor) {
            return { available: true, definitions, windows: [], complete: false }
          }
          cursor = page.nextCursor
        }
        signal?.throwIfAborted()
        const listed = await service.list({})
        return { available: true, definitions, windows: listed.status === 'listed' ? listed.sessions : [],
          complete: listed.status === 'listed' && listed.complete }
      } catch (_error) {
        signal?.throwIfAborted()
        // Catalog or online failures do not erase independently verified identity.
        return { available: true, definitions, windows: [], complete: false }
      }
    }
    const [identity, catalog] = await Promise.all([readIdentity(), readCatalog()])
    const node = await this.ctx.get('seatEngine')?.nodeStatus()
    const diagnostics = node?.failure || node?.openingFailures?.length
      ? { ...(node.failure ? { engine: node.failure } : {}), openings: node.openingFailures ?? [] } : undefined
    return { ...catalog, ...identity, ...(diagnostics ? { diagnostics } : {}) }
  }

  /** Open with the existing manual provider, never sending the opening sentence.
   * @param request - Explicit seat, revision and stable operation identity.
   * @returns Provider result with a draft for user confirmation.
   */
  @Remote
  async open(request: SeatUiOpenRequest): Promise<SeatUiOpenResult> {
    const service = await this.service()
    if (!service) return { status: 'rejected', error: { code: 'unavailable', message: 'Seat providers are unavailable.',
      alternative: 'Enable the local seat providers before opening this seat.', retryable: true, effectState: 'none' } }
    return service.open({ ...request, origin: 'manual', openingMode: 'prefill' })
  }
}
