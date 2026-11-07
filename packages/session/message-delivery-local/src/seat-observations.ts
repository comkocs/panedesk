/** Sequential bounded remote observations never turn an unreachable node into an empty snapshot. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import type { NodeId, SeatNodeObservation } from '@panedesk/dsh-message-delivery'
import type { NodeDelegationRequest } from '@panedesk/dsh-node-link'

/** Query each configured peer with one in-flight request and an entry-bounded deadline.
 * @param ctx - Provider context with the optional router.
 * @param nodeId - Local mailbox identity.
 * @param maxNodes - Maximum peers inspected in this observation.
 * @param signal - Provider lifetime; stops dispatch after disposal.
 * @param nodeTimeoutMs - Configured maximum duration for each node observation.
 * @returns Explicit remote observations or unknown nodes.
 */
export async function observeRemoteSeats(ctx: Context, nodeId: NodeId, maxNodes: number,
  signal: AbortSignal, nodeTimeoutMs: number): Promise<SeatNodeObservation[]> {
  const router = ctx.get('nodeRouter')
  if (!router) return []
  const { digest } = await import('@panedesk/dsh-'.concat('host-admin')) as typeof import('@panedesk/dsh-host-admin')
  const output: SeatNodeObservation[] = []
  const observation = new AbortController()
  for (const node of (await router.status()).slice(0, maxNodes)) {
    const target = node.nodeId
    if (signal.aborted || observation.signal.aborted || !node.reachable) {
      output.push({ nodeId: target, state: 'unknown', reason: 'unavailable' })
      continue
    }
    const operationId = randomUUID()
    const payload = { operationId }
    const prepared = { version: 'node-link/v1', requestId: randomUUID(), operationId, sourceNodeId: nodeId,
      targetNodeId: node.nodeId, deadline: new Date(Date.now() + nodeTimeoutMs).toISOString(), hop: 1,
      method: 'messages.onlineSeats', payload, payloadDigest: digest(payload) } as NodeDelegationRequest
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel: (() => void) | undefined
    try {
      const work = async (): Promise<SeatNodeObservation> => {
        if (signal.aborted || observation.signal.aborted) return { nodeId: target, state: 'unknown', reason: 'unavailable' }
        const delegation = { kind: 'node-delegation' as const, hop: 1 as const,
          principalId: String(nodeId) as import('@panedesk/dsh-seat').SeatPrincipalId,
          authorizationRef: operationId as import('@panedesk/dsh-seat').AuthorizationRef,
          sourceNodeId: prepared.sourceNodeId, targetNodeId: prepared.targetNodeId, operationId: prepared.operationId,
          requestDigest: prepared.payloadDigest, expiresAt: prepared.deadline, taskIds: [] }
        const response = await router.route({ ...prepared, delegation },
          { reconcile: false, active: () => !signal.aborted && !observation.signal.aborted })
        if (response.status !== 'ok' || response.method !== 'messages.onlineSeats'
          || response.result.some(row => row.nodeId !== target)) return { nodeId: target, state: 'unknown', reason: 'unavailable' }
        return { nodeId: target, state: 'observed', seats: response.result }
      }
      const timeout = new Promise<SeatNodeObservation>((resolve) => {
        cancel = () => {
          observation.abort()
          resolve({ nodeId: target, state: 'unknown', reason: 'unavailable' })
        }
        signal.addEventListener('abort', cancel, { once: true })
        timer = setTimeout(cancel, nodeTimeoutMs)
        if (signal.aborted) cancel()
      })
      output.push(await Promise.race([work(), timeout]))
    } catch (error) {
      void error
      output.push({ nodeId: target, state: 'unknown', reason: 'unavailable' })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (cancel) signal.removeEventListener('abort', cancel)
    }
  }
  return output
}
