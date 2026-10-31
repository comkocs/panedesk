/** Bounded source parsing and three-way previews; source bytes never execute as instructions. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import Papa from 'papaparse'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import type { Nodes } from 'mdast'
import type { CommitSeatImportRequest, CommitSeatImportResult, PreviewSeatImportRequest,
  SeatDefinition, SeatDigest, SeatImportPlan, SeatImportPlanId, SeatImportRow, SeatJson, SeatName } from '@panedesk/dsh-seat'
import { resolveCatalogDefinition, type DefinitionCatalogs } from './schema.ts'
import { digest, SeatStore } from './store.ts'
import { refuse, SeatLocalError } from './errors.ts'

function fields(definition: SeatDefinition): Record<string, SeatJson> {
  const { source: _source, revision: _revision, ...values } = definition
  const parsed: unknown = JSON.parse(JSON.stringify(values))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    refuse('invalid-definition', 'Definition fields are not a record.', 'Correct the definition before importing.')
  }
  return Object.fromEntries(Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right)))
}
function nodeText(node: Nodes): string {
  if ('value' in node) return node.value
  if ('children' in node) return node.children.map(child => nodeText(child)).join('')
  return ''
}
function parseRows(content: string, request: PreviewSeatImportRequest): { row: number; values: Record<string, string> }[] {
  if (request.format === 'csv') {
    const result = Papa.parse<Record<string, string>>(content, { header: true, delimiter: ',', skipEmptyLines: 'greedy' })
    if (result.errors.length) refuse('invalid-definition', result.errors.map(error => error.message).join('; '), 'Correct the CSV source before importing.')
    return result.data.map((values, index) => ({ row: index + 2, values }))
  }
  const tree = fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  let heading = ''
  const tables = tree.children.flatMap((node) => {
    if (node.type === 'heading') heading = nodeText(node)
    return node.type === 'table' && (request.table === undefined || heading === request.table) ? [node] : []
  })
  if (tables.length !== 1) refuse('invalid-definition', 'Select exactly one Markdown table.', 'Set table to its unique preceding heading.')
  const table = tables[0]
  const header = table?.children[0]
  if (table === undefined || header === undefined) refuse('invalid-definition', 'Table header is missing.', 'Provide a header row.')
  const headers = header.children.map(nodeText)
  if (new Set(headers).size !== headers.length) refuse('invalid-definition', 'Duplicate table column names.', 'Use unique headers.')
  return table.children.slice(1).map((row) => {
    if (row.position === undefined) refuse('invalid-definition', 'Table row location is missing.', 'Preview a source with row locations.')
    return { row: row.position.start.line, values: Object.fromEntries(row.children.map((cell, index) => {
      const name = headers[index]
      if (name === undefined) refuse('invalid-definition', 'Table row exceeds its header.', 'Correct the table columns.')
      return [name, nodeText(cell)]
    })) }
  })
}
const structuredFields = new Set(['directories', 'memoryDirectories', 'opening', 'openingInstructionFiles',
  'subscriptions', 'checkpointFiles', 'wakeTemplate', 'rules', 'worktree'])
const numericFields = new Set(['revision', 'schemaVersion', 'maxOpenSessions', 'maxActiveSubagents',
  'contextThresholdTokens', 'subagentContextThresholdTokens', 'pollingThreshold', 'maxSleepSeconds'])

/** Persists preview selections across callers while source bytes and revision remain current. */
export class SeatImporter {
  constructor(private readonly store: SeatStore, private readonly catalogs: DefinitionCatalogs,
    private readonly limits: { maxSourceBytes: number; maxPlans: number; importPlanTtlMs?: number; maxSeats?: number }) {}

  private async source(request: Pick<PreviewSeatImportRequest, 'sourcePath'>): Promise<{ text: string; hash: SeatDigest }> {
    if ((await stat(request.sourcePath)).size > this.limits.maxSourceBytes) refuse('invalid-definition', 'Import source exceeds the configured byte limit.', 'Select a smaller source.')
    const bytes = await readFile(request.sourcePath)
    if (bytes.byteLength > this.limits.maxSourceBytes) refuse('invalid-definition', 'Import source grew past the configured byte limit.', 'Select a smaller source.')
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), hash: createHash('sha256').update(bytes).digest('hex') as SeatDigest }
  }

  /** Preview independently validated rows without writing the catalog.
   * @param request - selected source and explicit column-to-field mapping.
   * @returns preview bound to source bytes and catalog revision.
   */
  async preview(request: PreviewSeatImportRequest): Promise<SeatImportPlan> {
    const source = await this.source(request)
    const catalog = this.store.snapshot()
    const mappingHash = digest({ columnMap: request.columnMap, defaults: request.defaults, table: request.table, format: request.format })
    const rows: SeatImportRow[] = []
    for (const row of parseRows(source.text, request)) {
      const values: Record<string, unknown> = { ...request.defaults }
      try {
        for (const [column, field] of Object.entries(request.columnMap)) {
          const value = row.values[column]
          if (value === undefined) refuse('invalid-definition', `Missing mapped column ${column}.`, 'Correct the column mapping.')
          if (value !== '') {
            if (field === 'directories:path') values.directories = [{ path: value, startup: true }]
            else if (field === 'opening:text') values.opening = { kind: 'text', text: value }
            else if (field === 'model:route') {
              const route: unknown = JSON.parse(value)
              if (typeof route !== 'object' || route === null || Array.isArray(route)) {
                refuse('invalid-definition', 'Model route must be a JSON object.', 'Provide model and reasoningEffort, with an optional provider.')
              }
              for (const key of ['provider', 'model', 'reasoningEffort']) {
                if (key in route) {
                  const entry: unknown = Object.getOwnPropertyDescriptor(route, key)?.value
                  if (typeof entry !== 'string' || !entry.trim()) refuse('invalid-definition', 'Model route fields must be nonempty strings.', 'Correct the model route cell.')
                  values[key] = entry
                }
              }
              if (!('model' in route) || !('reasoningEffort' in route)) refuse('invalid-definition', 'Model route is incomplete.', 'Provide explicit model and reasoningEffort values.')
            } else if (field === 'autoKeepAlive') {
              if (value !== 'true' && value !== 'false') refuse('invalid-definition', 'Expected true or false.', 'Correct the boolean cell.')
              values[field] = value === 'true'
            } else values[field] = structuredFields.has(field) ? JSON.parse(value) : numericFields.has(field) ? Number(value) : value
          }
        }
        const resolved = resolveCatalogDefinition(values, this.catalogs)
        if ('status' in resolved) throw new SeatLocalError(resolved.error)
        if (this.catalogs.nodeAliases[resolved.node] === this.catalogs.nodeId) {
          const error = await this.catalogs.validateOptions(resolved)
          if (error !== null) throw new SeatLocalError(error.error)
        }
        const normalized = fields(resolved)
        const rowHash = digest(normalized)
        const columnHashes = Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, digest(value)]))
        const local = catalog.definitions.find(item => item.seat === resolved.seat)
        const baseline = local?.source?.baseline
        const localFields = local === undefined ? {} : fields(local)
        const differences = Object.keys(normalized).flatMap((field) => {
          const b = baseline?.[field] ?? null, l = localFields[field] ?? null, s = normalized[field] ?? null
          const manual = local !== undefined && digest(l) !== digest(b)
          const changed = digest(s) !== digest(b)
          return digest(l) === digest(s) && !manual ? [] : [{ field, baseline: b, local: l, source: s, conflict: manual && changed }]
        })
        const conflict = local !== undefined && baseline !== undefined
          && digest(localFields) !== digest(baseline) && digest(normalized) !== digest(baseline)
        const merged = { ...normalized }
        let retainedLocal = false
        for (const difference of differences) {
          if (digest(difference.local) !== digest(difference.baseline)) {
            merged[difference.field] = difference.local
            retainedLocal = true
          }
        }
        const mergedContent = { ...resolved, ...merged }
        const storedFields = local === undefined ? undefined : fields(local)
        const mergedForFields = local?.source === undefined
          ? { ...mergedContent, revision: local?.revision ?? 1 }
          : { ...mergedContent, revision: local.revision, source: local.source }
        const mergedFields = local === undefined ? undefined : fields(mergedForFields)
        const contentChanged = storedFields === undefined || mergedFields === undefined || digest(storedFields) !== digest(mergedFields)
        const added = contentChanged || retainedLocal ? 1 : 0
        const definition = { ...mergedContent, revision: local === undefined ? 1 : local.revision + added,
          source: { sourcePath: request.sourcePath, sourceFileHash: source.hash, rowHash, mappingHash,
            columnHashes, baseline: normalized, authority: catalog.authority } } as SeatDefinition
        rows.push({ row: row.row, seat: resolved.seat, definition, rowHash, columnHashes,
          action: conflict ? 'conflict' : local === undefined ? 'create' : digest(fields(local)) === digest(fields(definition)) ? 'retain' : 'update',
          selected: !conflict, differences, diagnostics: [] })
      } catch (error) {
        if (!(error instanceof SeatLocalError) && !(error instanceof SyntaxError)) throw error
        rows.push({ row: row.row, seat: typeof values.seat === 'string' ? values.seat as SeatName : null,
          definition: null, rowHash: digest(row.values), columnHashes: {}, action: 'invalid', selected: false, differences: [],
          diagnostics: [error instanceof SeatLocalError ? error.failure : { code: 'invalid-definition', message: 'Invalid JSON cell.', alternative: 'Correct the mapped JSON field.', retryable: false, effectState: 'none' }] })
      }
    }
    for (const row of rows) if (row.seat !== null && rows.filter(other => other.seat === row.seat).length > 1) { row.action = 'invalid'; row.selected = false }
    const present = new Set(rows.map(row => row.seat))
    for (const local of catalog.definitions) if (local.source?.sourcePath === request.sourcePath && !present.has(local.seat)) {
      rows.push({ row: -rows.length - 1, seat: local.seat, definition: local, rowHash: digest(fields(local)), columnHashes: {}, action: 'tombstone', selected: false, differences: [], diagnostics: [] })
    }
    const plan: SeatImportPlan = { planId: randomUUID() as SeatImportPlanId, sourceFileHash: source.hash,
      mappingHash, baseRevision: catalog.revision, rows }
    await this.store.retainImportPlan({ plan, sourcePath: request.sourcePath,
      expiresAt: Date.now() + (this.limits.importPlanTtlMs ?? 86400000) }, this.limits.maxPlans)
    return plan
  }

  /** Recheck source bytes and CAS before applying only selected, nonconflicting rows.
   * @param request - retained plan, selected rows and observed catalog revision.
   * @returns committed revision; conflicting rows and tombstones never overwrite data.
   */
  async commit(request: CommitSeatImportRequest): Promise<CommitSeatImportResult> {
    const replay = this.store.committedImportPlan(request.planId, request.operationId)
    if (replay !== undefined) {
      const receipt = this.store.snapshot().operations[request.operationId]
      if (receipt !== undefined && digest(request) === receipt.digest) {
        return { status: 'committed', revision: receipt.revision, rows: structuredClone(replay.plan.rows) }
      }
      refuse('operation-id-conflict', 'Operation identity has different contents.', 'Use the original request or a new operation identity.')
    }
    const retained = this.store.importPlan(request.planId)
    if (retained === undefined) refuse('import-preview-stale', 'Import preview is no longer available.', 'Preview the source again.')
    const { plan } = retained
    let source: { text: string; hash: SeatDigest }
    try { source = await this.source(retained) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        refuse('import-preview-stale', 'Import source is no longer available.', 'Preview the source again.')
      }
      throw error
    }
    if (source.hash !== plan.sourceFileHash || request.expectedRevision !== plan.baseRevision) {
      refuse('import-preview-stale', 'Source bytes or selected revision changed.', 'Preview the source again.')
    }
    const selected = new Set(request.selectedRows)
    if (selected.size !== request.selectedRows.length || request.selectedRows.some(row => !plan.rows.some(item => item.row === row))) {
      refuse('invalid-request', 'The selection contains duplicate or unknown rows.', 'Select row identities from the preview.')
    }
    const revision = await this.store.mutate(request.expectedRevision, request.operationId, request, (catalog) => {
      if (catalog.authority !== 'import-source') refuse('seat-store-authoritative', 'The catalog owns editing authority.', 'Edit the catalog instead of importing updates.')
      for (const row of plan.rows) {
        if (!selected.has(row.row) || row.definition === null || row.action === 'conflict' || row.action === 'invalid'
          || row.action === 'tombstone' || row.action === 'retain') continue
        const index = catalog.definitions.findIndex(item => item.seat === row.seat)
        const stored = index < 0 ? undefined : catalog.definitions[index]
        const next = stored === undefined || row.definition.revision > stored.revision
          ? row.definition : { ...row.definition, revision: stored.revision + 1 }
        if (index < 0) catalog.definitions.push(next)
        else catalog.definitions[index] = next
      }
    }, 'import-preview-stale', this.limits.maxSeats)
    await this.store.releaseImportPlan(request.planId, request.operationId)
    return { status: 'committed', revision, rows: structuredClone(plan.rows) }
  }
}
