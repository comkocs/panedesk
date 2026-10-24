/** Loadable offline observations never acquire a writer or start engine drivers. */
import type { Context } from '@panedesk/cordis'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import { SeatEngineQueryService, type SeatNodeId, type SeatRejected } from '@panedesk/dsh-seat'
import type * as T from '@panedesk/dsh-seat'
import { EngineError } from './journal.ts'
import { EngineProjection } from './projection.ts'
import { queryEngine, serializeEngine, verifyEngine, redactPending } from './query.ts'
import { decodeAuthorizationFrame } from './authorization-storage.ts'
import { queryLegacyAuthorizations, queryTasks } from './authorization-query.ts'

/** Node selection never initializes the accounting ledger identity. */
export interface Config {
  home?: string
  nodeId?: SeatNodeId
  maxDecisionBytes: number
}
/** Loader plugin identity for observations only. */
export const name = 'seat-engine-query'
/** No runtime services are required or activated. */
export const inject: string[] = []

function refusal(error: unknown): SeatRejected {
  const code = error instanceof EngineError ? error.code : error instanceof SyntaxError ? 'engine-store-corrupt' : 'unavailable'
  return { status: 'rejected', error: { code, message: code === 'engine-store-corrupt'
    ? 'The engine journal contains an invalid complete frame.' : 'The engine query cannot read the requested data.',
  alternative: 'Check the selected home, node and input without modifying the journal.',
  retryable: code === 'unavailable', effectState: 'none' } }
}
async function observe<T>(read: () => Promise<T>): Promise<T | SeatRejected> {
  try { return await read() } catch (error) { return refusal(error) }
}
function validNode(node: string): boolean { return !!node && node !== '.' && node !== '..' && !/[\\/\0]/.test(node) }

/** Fresh request-local projections contain only the complete verified journal prefix. */
export class SeatEngineReader extends SeatEngineQueryService {
  private readonly home: string
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    if (!Number.isSafeInteger(config.maxDecisionBytes) || config.maxDecisionBytes < 1
      || (config.nodeId !== undefined && !validNode(config.nodeId))) {
      throw new EngineError('invalid-request', 'Invalid engine reader configuration')
    }
    this.home = resolveDshHome(config.home)
    ctx.provide('seatAuthorizationQueries', {
      query: request => observe(async () => {
        const { projection, complete } = await this.snapshot()
        const result = queryLegacyAuthorizations(projection.authorizationDecisions, request)
        return { ...result, complete: complete && result.complete }
      }),
      tasks: request => observe(async () => {
        const { projection, complete } = await this.snapshot()
        const result = queryTasks(projection.decisions, request)
        return { ...result, complete: complete && result.complete }
      }),
    })
  }
  private async snapshot() {
    const nodeId = this.config.nodeId ?? await readFile(join(this.home, 'ledger/v1/node-id'), 'utf8') as SeatNodeId
    if (!validNode(nodeId)) throw new EngineError('engine-store-corrupt', 'Invalid stored node identity')
    const root = join(this.home, 'ledger/engine/v1', nodeId, 'events')
    const names = (await readdir(root)).filter(name => name.endsWith('.jsonl')).sort()
    if (!names.length) throw new EngineError('unavailable', 'No engine journal is available')
    const projection = new EngineProjection()
    let complete = true
    for (const name of names) {
      const text = await readFile(join(root, name), 'utf8')
      const lines = text.split('\n'), tail = lines.pop()
      for (const line of lines) {
        const decision = decodeAuthorizationFrame(line, this.config.maxDecisionBytes)
        if (decision.nodeId !== nodeId || decision.sequence !== projection.sequence + 1) {
          throw new EngineError('engine-store-corrupt', 'Engine node or sequence mismatch')
        }
        projection.applyAuthorization(decision)
      }
      if (tail || !text.length) { complete = false; break }
    }
    const after = (await readdir(root)).filter(name => name.endsWith('.jsonl')).sort()
    complete &&= names.length === after.length && names.every((name, index) => name === after[index])
    return { projection, complete, nodeId }
  }
  query(request: T.EngineQueryRequest): Promise<T.EngineQueryResult | SeatRejected> {
    return observe(async () => {
      const { projection, complete } = await this.snapshot()
      const result = queryEngine(projection.decisions, request)
      return { ...result, complete: complete && result.complete }
    })
  }
  pending(request: T.ListPendingSeatsRequest): Promise<T.ListPendingSeatsResult | SeatRejected> {
    return observe(async () => {
      const { projection, complete, nodeId } = await this.snapshot()
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new EngineError('invalid-request', 'Pending limit must be positive')
      if (request.cursor && (request.cursor.nodeId !== nodeId || request.cursor.sequence < 0 || request.cursor.effectIndex < 0)) {
        throw new EngineError('query-cursor-invalid', 'Cursor does not belong to this journal')
      }
      const all = [...projection.pending.values()].sort((a, b) => a.sequence - b.sequence)
        .filter(item => (!request.projectId || item.projectId === request.projectId) && (!request.seat || item.seat === request.seat)
          && (!request.cursor || item.sequence > request.cursor.sequence))
      const items = all.slice(0, request.limit).map(redactPending)
      const last = items.at(-1)
      return { items, complete: complete && all.length <= request.limit, watermark: projection.sequence,
        ...(last ? { nextCursor: { nodeId, sequence: last.sequence, effectIndex: 0 } } : {}) }
    })
  }
  export(request: T.EngineExportRequest): ReturnType<SeatEngineQueryService['export']> {
    return observe(async () => {
      const { projection, complete } = await this.snapshot()
      return { ...serializeEngine(projection.decisions, request),
        complete: complete && queryEngine(projection.decisions, request.query).complete }
    })
  }
  verify(request: T.EngineVerifyRequest): Promise<T.EngineVerifyResult> {
    return observe(() => verifyEngine(request.input, this.config.maxDecisionBytes))
  }
}
/** Install only the read-only service; loading does not touch the selected home.
 * @param ctx - plugin owner.
 * @param config - home, optional node and explicit frame byte limit.
 */
export function apply(ctx: Context, config: Config): void { ctx.plugin(SeatEngineReader, config) }
