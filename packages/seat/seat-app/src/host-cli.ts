/** Explicit read-only CLI projections over the running composition's providers. */
import type { Context } from '@panedesk/cordis'
import { hostProjection, type HostProjectionMethods } from '@panedesk/dsh-sdk-jsonrpc-server'

/** Handle node and authorization commands without starting a second engine.
 * @param ctx - Trusted launcher context.
 * @param args - Explicit query and long flags.
 * @returns Command output, or undefined when an existing seat command owns the input.
 */
export async function executeHostCommand(ctx: Context, args: readonly string[]): Promise<{ code: number; output: unknown } | undefined> {
  if (!['nodes', 'authorizations'].includes(args[0] ?? '')) return undefined
  try {
    const group = args[0], action = args[1]
    let method: keyof HostProjectionMethods
    if (group === 'nodes' && (action === 'list' || action === 'status')) method = `nodes/${action}`
    else if (group === 'authorizations' && action === 'query') method = 'authorizations/query'
    else throw new TypeError('Unknown host query')
    const fields: Record<string, string> = { '--node': 'nodeId', '--task': 'taskId', '--seat': 'seat', '--kind': 'kind',
      '--from': 'from', '--to': 'to', '--cursor': 'cursor', '--limit': 'limit' }
    const request: Record<string, unknown> = {}
    let encoded: string | undefined
    for (let i = 2; i < args.length; i++) {
      const flag = args[i] ?? ''
      if (flag === '--json') continue
      const value = args[++i]
      if (value === undefined || value.startsWith('--')) throw new TypeError('Missing query option value')
      if (flag === '--request') {
        if (encoded !== undefined) throw new TypeError('Duplicate query request')
        encoded = value
        continue
      }
      const key = fields[flag]
      if (key === undefined || Object.hasOwn(request, key)) throw new TypeError('Unknown or duplicate query option')
      request[key] = key === 'limit' ? Number(value) : key === 'cursor' ? JSON.parse(value) : value
    }
    if (encoded !== undefined && Object.keys(request).length > 0) throw new TypeError('JSON request cannot be combined with filters')
    if (method === 'authorizations/query') request.limit ??= 100
    const output = await hostProjection(ctx, method, encoded === undefined ? request : JSON.parse(encoded))
    const rejected = output !== null && typeof output === 'object' && 'status' in output && output.status === 'rejected'
    return { code: rejected ? 2 : 0, output }
  } catch (error) {
    void error
    return { code: 2, output: { status: 'rejected', error: { code: 'unavailable-or-invalid-query',
      message: 'Check query filters and provider availability; no host was started.' } } }
  }
}
