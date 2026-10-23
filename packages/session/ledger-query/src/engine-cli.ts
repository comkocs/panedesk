/** Strict arguments for the independent engine journal reader. */
import { SEAT_ENGINE_EVENT_NAMES } from '@panedesk/dsh-seat'
import type { EngineQueryRequest, EngineExportRequest, EngineVerifyRequest, ListSeatGatesRequest, ListPendingSeatsRequest } from '@panedesk/dsh-seat'

/** Parsed queries never imply an engine mutation or a Session activation. */
export type EngineCommand =
  | { action: 'events'; request: EngineQueryRequest }
  | { action: 'gates'; request: ListSeatGatesRequest }
  | { action: 'pending'; request: ListPendingSeatsRequest }
  | { action: 'export'; request: EngineExportRequest }
  | { action: 'verify'; request: EngineVerifyRequest }

/** Usage failures contain no source payloads or credentials. */
export class EngineArgumentError extends Error {}
function invalid(): never { throw new EngineArgumentError('Invalid engine arguments; use an explicit command, filters and positive limit') }
function timestamp(value: string): string {
  const qualified = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  if (!qualified || !Number.isFinite(Date.parse(value))) invalid()
  return value
}

/** Parse the engine subcommand without opening its journal.
 * @param args - arguments beginning with engine.
 * @returns one validated read-only operation.
 */
export function parseEngineArgs(args: readonly string[]): EngineCommand {
  const action = args[1]
  const filters = ['--seat', '--node', '--kind', '--from', '--to', '--cursor', '--limit', '--json']
  const allowed = { events: filters, gates: ['--gate', '--cursor', '--limit', '--json'],
    pending: ['--project', '--seat', '--cursor', '--limit', '--json'],
    export: [...filters, '--format', '--output'], verify: ['--input', '--json'] }
  if (!action || !Object.hasOwn(allowed, action)) invalid()
  const kind = action as keyof typeof allowed
  const flags = new Map<string, string>()
  for (let i = 2; i < args.length; i++) {
    const flag = args[i] ?? ''
    if (!allowed[kind].includes(flag) || flags.has(flag)) invalid()
    const value = flag === '--json' ? 'true' : args[++i]
    if (!value || value.startsWith('--')) invalid()
    flags.set(flag, value)
  }
  const require = (flag: string): string => flags.get(flag) ?? invalid()
  if (kind === 'verify') return { action: kind, request: { input: require('--input') } }
  const limit = flags.has('--limit') ? Number(require('--limit')) : 100
  if (!Number.isSafeInteger(limit) || limit <= 0) invalid()
  const query: EngineQueryRequest = { limit }
  if (flags.has('--cursor')) {
    let value: unknown
    try { value = JSON.parse(require('--cursor')) } catch (error) { void error; invalid() }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !('nodeId' in value) || typeof value.nodeId !== 'string' || !value.nodeId
      || !('sequence' in value) || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || !('effectIndex' in value) || typeof value.effectIndex !== 'number' || !Number.isSafeInteger(value.effectIndex) || value.effectIndex < 0
      || Object.keys(value).some(key => !['nodeId', 'sequence', 'effectIndex'].includes(key))) invalid()
    query.cursor = { nodeId: value.nodeId as NonNullable<EngineQueryRequest['nodeId']>, sequence: value.sequence, effectIndex: value.effectIndex }
  }
  if (kind === 'gates') return { action: kind, request: { limit, ...query.cursor && { cursor: query.cursor }, ...flags.has('--gate') && { gateId: require('--gate') } } }
  if (flags.has('--seat')) query.seat = require('--seat') as NonNullable<EngineQueryRequest['seat']>
  if (kind === 'pending') return { action: kind, request: { limit, ...query.cursor && { cursor: query.cursor }, ...query.seat && { seat: query.seat },
    ...flags.has('--project') && { projectId: require('--project') as NonNullable<ListPendingSeatsRequest['projectId']> } } }
  if (flags.has('--node')) query.nodeId = require('--node') as NonNullable<EngineQueryRequest['nodeId']>
  if (flags.has('--kind')) {
    const kinds = require('--kind').split(',')
    if (kinds.some(name => !Object.hasOwn(SEAT_ENGINE_EVENT_NAMES, name)) || new Set(kinds).size !== kinds.length) invalid()
    query.kinds = kinds as NonNullable<EngineQueryRequest['kinds']>
  }
  if (flags.has('--from')) query.from = timestamp(require('--from'))
  if (flags.has('--to')) query.to = timestamp(require('--to'))
  if (query.from !== undefined && query.to !== undefined && Date.parse(query.from) >= Date.parse(query.to)) invalid()
  if (kind === 'export') {
    if (require('--format') !== 'jsonl') invalid()
    return { action: kind, request: { query, format: 'jsonl', output: require('--output') } }
  }
  return { action: 'events', request: query }
}
