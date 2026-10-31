/** Fixed statistics address vocabulary shared by controls and the resource provider. */
import type { StatsDetailCursor, StatsRequest } from '@panedesk/dsh-ledger-query/types'

/** Parse the owned resource address without accepting arbitrary ledger query options.
 * @param params - Resource address search parameters.
 * @returns Fixed-range selection with optional attribution filters.
 */
export function selection(params: URLSearchParams): StatsRequest {
  const range = params.get('range'), group = params.get('groupBy')
  const seat = params.get('seat'), taskId = params.get('taskId'), model = params.get('model')
  const limit = params.get('detailsLimit'), cursor = params.get('after')
  let after: StatsDetailCursor | undefined
  if (cursor !== null) {
    const value: unknown = JSON.parse(cursor)
    if (typeof value !== 'object' || value === null || !('startedAt' in value) || !('asOf' in value)
      || !('nodeId' in value) || !('callId' in value) || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
      || typeof value.asOf !== 'number' || !Number.isFinite(value.asOf) || typeof value.nodeId !== 'string' || typeof value.callId !== 'string') {
      throw new Error('Invalid statistics detail cursor')
    }
    after = { startedAt: value.startedAt, asOf: value.asOf,
      nodeId: value.nodeId as StatsDetailCursor['nodeId'], callId: value.callId as StatsDetailCursor['callId'] }
  }
  if (limit !== null && (!Number.isSafeInteger(Number(limit)) || Number(limit) <= 0)) throw new Error('Invalid statistics detail limit')
  return {
    ...(limit === null ? {} : { details: { limit: Number(limit), ...(after === undefined ? {} : { after }) } }),
    range: range === '6h' || range === '24h' || range === '72h' || range === '168h' || range === 'all' ? range : 'today',
    bucket: params.get('bucket') === 'day' ? 'day' : 'hour',
    groupBy: group === 'taskId' || group === 'model' || group === 'window' || group === 'role' || group === 'definition' ? group : 'seat',
    ...(seat === null ? {} : { seat }),
    ...(taskId === null ? {} : { taskId }),
    ...(model === null ? {} : { model }),
  }
}
