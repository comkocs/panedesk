/** Worktree admission acknowledges only durable, authoritative host registrations. */
import type { Context } from '@panedesk/cordis'
import type { RegisterSeatWorktreeRequest, SeatTaskEndedRequest, SeatWorktreeResult } from '@panedesk/dsh-seat'
import { WorktreePolicy } from './worktree.ts'

/** Register with read-only verification and retry on catalog races.
 * @param ctx - optional authoritative host and seat definition services.
 * @param request - explicit tree identity and authorized force reference.
 * @returns durable registration or an actionable refusal without mutation.
 */
export async function registerWorktree(ctx: Context, request: RegisterSeatWorktreeRequest): Promise<SeatWorktreeResult> {
  const host = ctx.get('seatWorktreeHost')
  const seats = ctx.get('seats')
  if (!host || !seats) return unavailable()
  const definition = await seats.resolve(request.registration.seat)
  if ('status' in definition) return definition
  const policy = new WorktreePolicy(definition.worktree, tree => host.inspect(tree), item => host.authorize(item))
  for (;;) {
    const catalog = await host.read()
    const admitted = await policy.register(request, catalog.trees)
    const node = await ctx.get('seatEngine')?.nodeStatus()
    const decisions = node ? await ctx.get('seatGates')?.evaluate({
      hook: 'before-open', callId: `worktree:${request.operationId}` as import('@panedesk/dsh-seat').GateContext['callId'],
      operationId: request.operationId, nodeId: node.nodeId, seat: request.registration.seat, sessionId: null,
      observedAt: new Date().toISOString(), cwd: request.registration.path, candidateSeats: [],
      worktreeFacts: { event: 'register', requestedKind: request.registration.kind,
        clientTreeCount: catalog.trees.filter(tree => tree.seat === request.registration.seat
          && tree.kind === 'client' && tree.path !== request.registration.path).length,
        clientTreeLimit: definition.worktree.clientTreesPerSlot,
        authorizedForce: admitted.status !== 'rejected' && request.force !== undefined,
        alternative: admitted.status === 'rejected' ? admitted.error.alternative : 'Use the registered client tree.', mature: false },
    }) : undefined
    const denied = decisions?.find(result => result.outcome === 'deny')
    if (denied?.outcome === 'deny') return { status: 'rejected', error: denied.reason }
    if (admitted.status === 'rejected') return admitted
    if (await host.commit(request, catalog.revision) === 'committed') return admitted
  }
}

/** Observe settlement without removing or committing a tree.
 * @param ctx - authoritative registration host and resolved seat profiles.
 * @param request - authenticated task settlement identity.
 * @returns cleanup suggestions for committed registrations only.
 */
export async function taskEnded(ctx: Context, request: SeatTaskEndedRequest): Promise<SeatWorktreeResult> {
  const host = ctx.get('seatWorktreeHost')
  const seats = ctx.get('seats')
  if (!host || !seats) return unavailable()
  const catalog = await host.read()
  const alternatives: string[] = []
  const trees = catalog.trees.filter(tree => tree.taskId === request.taskId)
  for (const tree of trees) {
    const definition = await seats.resolve(tree.seat)
    if ('status' in definition) return definition
    const policy = new WorktreePolicy(definition.worktree, item => host.inspect(item), item => host.authorize(item))
    const result = policy.onTaskEnded(request, [tree])
    if (result.status !== 'rejected') {
      alternatives.push(...result.alternatives)
      const mature = await policy.mature([tree], Date.now())
      if (mature.status !== 'rejected') alternatives.push(...mature.alternatives)
      const node = await ctx.get('seatEngine')?.nodeStatus()
      if (node) {
        for (const event of ['task-ended', 'mature'] as const) {
          await ctx.get('seatGates')?.evaluate({ hook: 'before-tool-call',
            callId: `worktree:${request.operationId}:${tree.path}:${event}` as import('@panedesk/dsh-seat').GateContext['callId'],
            operationId: request.operationId, nodeId: node.nodeId, seat: tree.seat, sessionId: null,
            observedAt: new Date().toISOString(), toolName: 'worktree-observation', arguments: {}, hasPendingWork: false,
            worktreeFacts: { event, requestedKind: tree.kind, clientTreeCount: 0, clientTreeLimit: definition.worktree.clientTreesPerSlot,
              authorizedForce: false, alternative: result.alternatives.join('\n'),
              mature: mature.status !== 'rejected' && mature.trees.length > 0 },
          })
        }
      }
    }
  }
  return { status: 'observed', trees, alternatives }
}

function unavailable(): import('@panedesk/dsh-seat').SeatRejected {
  return { status: 'rejected', error: {
    code: 'worktree-unverified', message: 'Authoritative worktree evidence is unavailable.',
    alternative: 'Install the durable worktree host before registering a tree.', retryable: false, effectState: 'none',
  } }
}
