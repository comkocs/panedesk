/** Optional forwarding keeps the local provider unchanged when no peer or issuer is installed. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import type * as Seat from '@panedesk/dsh-seat'
import { NODE_LINK_VERSION, type NodeDelegationRequest, type NodeRouteMethods } from '@panedesk/dsh-node-link'
import { digest } from './store.ts'
import { rejected } from './errors.ts'

type Method = Exclude<keyof NodeRouteMethods, 'messages.send'>
/** Route one exact remote operation using an entry-captured issuer.
 * @param ctx - Optional router and trusted entry issuer.
 * @param source - Actual local node identity.
 * @param target - Selected owning node, never inferred from a principal name.
 * @param authority - Captured original caller, used only to prevent issuer identity substitution.
 * @param method - Frozen seat method.
 * @param payload - Original operation parameters.
 * @returns Remote result, safe refusal, or undefined when routing is not installed or not needed.
 */
export async function routeSeat<K extends Method>(ctx: Context, source: Seat.SeatNodeId, target: Seat.SeatNodeId | undefined,
  authority: Seat.SeatCallContext, method: K, payload: NodeRouteMethods[K]['request'],
): Promise<NodeRouteMethods[K]['result'] | Seat.SeatRejected | undefined> {
  if (target === undefined || target === source) return undefined
  const router = ctx.get('nodeRouter'), issuer = ctx.get('nodeDelegationIssuer')
  if (!router || !issuer) return undefined
  if (authority.nodeId !== source || authority.authorization?.fact.kind === 'node-delegation') {
    return rejected('unauthorized', 'Forwarding authority is not local.', 'Use the original authenticated entry.')
  }
  const request = { version: NODE_LINK_VERSION, requestId: randomUUID(), sourceNodeId: source,
    targetNodeId: target, operationId: payload.operationId,
    deadline: new Date(Date.now() + issuer.expiry.maxLifetimeMs).toISOString(), hop: 1,
    method, payload, payloadDigest: digest(payload) } as NodeDelegationRequest
  const issued = await issuer.issue(request)
  if (issued.status === 'rejected') return rejected('unauthorized', issued.error.reason, 'Refresh the original authority.')
  if (issued.delegation.principalId !== authority.principalId) {
    return rejected('unauthorized', 'Delegation does not match the captured caller.', 'Use an entry-scoped issuer.')
  }
  const response = await router.route({ ...request, delegation: issued.delegation })
  if (response.status === 'ok') return response.result as NodeRouteMethods[K]['result']
  const refusal = rejected(response.error.code === 'cross-node-unsupported' ? 'cross-node-unsupported'
    : response.error.code === 'node-delegation-rejected' || response.error.code === 'node-authentication-failed' ? 'unauthorized' : 'unavailable',
  response.error.effectState === 'unknown' ? 'Remote operation outcome is unknown.' : response.error.reason,
  response.error.effectState === 'unknown' ? 'Query or retry the same operation identity; do not create a new operation.' : 'Restore the authenticated node link.')
  return { ...refusal, error: { ...refusal.error, effectState: response.error.effectState, retryable: response.error.retryable } }
}
