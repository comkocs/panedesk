/** Read-only node and authorization projections over optional host providers. */
import type { Context } from '@panedesk/cordis'
import { brandString } from '@panedesk/dsh-brand'
import type { NodeLinkStatus } from '@panedesk/dsh-node-link'
import type { SeatAuthorizationQueryRequest, SeatAuthorizationQueryResult, SeatRejected } from '@panedesk/dsh-seat'
import { JsonRpcResponseError } from '@panedesk/dsh-sdk-protocol'

/** Additive SDK methods preserve provider-owned pagination and health evidence. */
export interface HostProjectionMethods {
  'nodes/list': { request: Record<string, never>; result: readonly NodeLinkStatus[] }
  'nodes/status': { request: { nodeId: string }; result: NodeLinkStatus | null }
  'authorizations/query': { request: SeatAuthorizationQueryRequest; result: SeatAuthorizationQueryResult | SeatRejected }
}

/** Exact method recognition does not enable or instantiate a provider.
 * @param method - Wire method name.
 * @returns Whether this module owns the projection.
 */
export function isHostProjection(method: string): method is keyof HostProjectionMethods {
  return method === 'nodes/list' || method === 'nodes/status' || method === 'authorizations/query'
}

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid projection parameters')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('Expected a non-empty projection filter')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('Expected a non-negative projection cursor')
  return value
}

/** Decode wire filters without accepting caller authority.
 * @param value - Untrusted query fields.
 * @returns Provider-owned query preserving the exclusive scan cursor.
 */
export function decodeAuthorizationQuery(value: unknown): SeatAuthorizationQueryRequest {
  const input = object(value)
  const allowed = ['taskId', 'seat', 'nodeId', 'kind', 'from', 'to', 'cursor', 'limit']
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new TypeError('Unknown authorization query field')
  const limit = integer(input.limit)
  if (limit === 0) throw new TypeError('Authorization query limit must be positive')
  const query: SeatAuthorizationQueryRequest = { limit }
  if (input.taskId !== undefined) query.taskId = brandString<NonNullable<SeatAuthorizationQueryRequest['taskId']>>(text(input.taskId))
  if (input.seat !== undefined) query.seat = brandString<NonNullable<SeatAuthorizationQueryRequest['seat']>>(text(input.seat))
  if (input.nodeId !== undefined) query.nodeId = brandString<NonNullable<SeatAuthorizationQueryRequest['nodeId']>>(text(input.nodeId))
  for (const key of ['from', 'to'] as const) {
    if (input[key] !== undefined) {
      const timestamp = text(input[key])
      if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError('Invalid authorization query timestamp')
      query[key] = timestamp
    }
  }
  if (input.kind !== undefined) {
    const kind = input.kind
    switch (kind) {
      case 'model-tool-call': case 'human': case 'engine': case 'local-operator': case 'node-delegation': query.kind = kind as NonNullable<SeatAuthorizationQueryRequest['kind']>; break
      default: throw new TypeError('Invalid authorization kind filter')
    }
  }
  if (input.cursor !== undefined) {
    const cursor = object(input.cursor)
    if (Object.keys(cursor).some(key => !['nodeId', 'sequence', 'effectIndex'].includes(key))) throw new TypeError('Invalid authorization cursor')
    query.cursor = { nodeId: brandString<NonNullable<SeatAuthorizationQueryRequest['nodeId']>>(text(cursor.nodeId)),
      sequence: integer(cursor.sequence), effectIndex: integer(cursor.effectIndex) }
  }
  return query
}

/** Query an already running provider; callers establish authority before entering.
 * @param ctx - Authenticated host context with optional providers.
 * @param method - Fixed read-only projection name.
 * @param params - Untrusted filters, never authentication fields.
 * @returns Unmodified provider evidence, or an explicit unsupported error.
 */
export async function hostProjection(ctx: Context, method: keyof HostProjectionMethods, params: unknown): Promise<HostProjectionMethods[keyof HostProjectionMethods]['result']> {
  const input = object(params)
  if (method === 'authorizations/query') {
    const request = decodeAuthorizationQuery(input)
    const provider = ctx.get('seatAuthorizationQueries')
    if (provider?.query === undefined) throw new JsonRpcResponseError(-32601, 'Authorization queries are unavailable', { reason: 'unsupported' })
    return provider.query(request)
  }
  if (Object.keys(input).some(key => method !== 'nodes/status' || key !== 'nodeId')) throw new TypeError('Unknown node query field')
  const nodeId = method === 'nodes/status' ? text(input.nodeId) : undefined
  const router = ctx.get('nodeRouter')
  if (router === undefined) throw new JsonRpcResponseError(-32601, 'Node queries are unavailable', { reason: 'unsupported' })
  const nodes = await router.status()
  return method === 'nodes/list' ? nodes : nodes.find(node => node.nodeId === nodeId) ?? null
}
