/** Fixed statistics address vocabulary shared by controls and the resource provider. */
import type { StatsRequest } from '@panedesk/dsh-ledger-query/types'

/** Parse the owned resource address without accepting arbitrary ledger query options.
 * @param params - Resource address search parameters.
 * @returns Fixed-range selection with optional attribution filters.
 */
export function selection(params: URLSearchParams): StatsRequest {
  const range = params.get('range'), group = params.get('groupBy')
  const seat = params.get('seat'), taskId = params.get('taskId'), model = params.get('model')
  return {
    range: range === '6h' || range === '24h' || range === '72h' || range === '168h' || range === 'all' ? range : 'today',
    bucket: params.get('bucket') === 'day' ? 'day' : 'hour',
    groupBy: group === 'taskId' || group === 'model' || group === 'window' || group === 'role' || group === 'definition' ? group : 'seat',
    ...(seat === null ? {} : { seat }),
    ...(taskId === null ? {} : { taskId }),
    ...(model === null ? {} : { model }),
  }
}
