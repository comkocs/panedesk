/** Optional opening policies run before local admission writes or physical creation. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { LocalSeatService } from './service.ts'
import { validateLocalDefinition } from './paths.ts'
import { rejected } from './errors.ts'

/** Apply the local opening policy to direct engine ingress, retaining accepted replays.
 * @param ctx - local provider context.
 * @param service - durable opening facts and verified node identity.
 * @param input - frozen engine request.
 * @returns the policy refusal, or null for an allowed or already accepted opening.
 */
export async function engineOpeningGate(ctx: Context, service: LocalSeatService,
  input: T.SeatLocalOpenRequest): Promise<T.SeatRejected | null> {
  if (service.options.nodeAliases[input.definition.node] !== service.options.nodeId) {
    return rejected('cross-node-unsupported', 'The definition does not belong to this node.', 'Run the operation on its configured node.')
  }
  const refusal = validateLocalDefinition(input.definition)
  if (refusal !== null) return refusal
  const facts = (await service.state.read()).effects
  const accepted = facts.some(effect => (effect.kind === 'trigger/accepted' || effect.kind === 'trigger/coalesced')
    && effect.data.trigger.evidence.kind === 'manual'
    && effect.data.trigger.evidence.operationId === input.request.operationId)
  if (accepted) return null
  const startup = input.definition.directories.find(directory => directory.startup)
  if (!startup) return { status: 'rejected', error: { code: 'invalid-definition', message: 'Startup directory is unavailable.',
    alternative: 'Set the seat startup directory.', retryable: false, effectState: 'none' } }
  return openingGate(ctx, { ...openingContext(service.options.nodeId, input.request.operationId, input.request.seat),
    hook: 'before-open', cwd: startup.path, candidateSeats: [input.request.seat] })
}

/** Evaluate the installed policy without changing behavior when it is absent.
 * @param ctx - local provider context.
 * @param context - trusted opening identity and candidates.
 * @returns the first refusal, or null when all policies allow.
 */
export async function openingGate(ctx: Context, context: T.GateContext): Promise<T.SeatRejected | null> {
  const results = await ctx.get('seatGates')?.evaluate(context)
  const denied = results?.find(result => result.outcome === 'deny')
  return denied?.outcome === 'deny' ? { status: 'rejected', error: denied.reason } : null
}

/** Construct an opening policy call from the owning operation.
 * @param nodeId - verified local node.
 * @param operationId - stable operation identity.
 * @param seat - selected seat, or null for traditional creation.
 * @returns common policy attribution.
 */
export function openingContext(nodeId: T.SeatNodeId, operationId: T.SeatOperationId, seat: T.SeatName | null): T.GateContextBase {
  return { nodeId, operationId, seat, sessionId: null, observedAt: new Date().toISOString(),
    callId: `open:${operationId}` as T.GateContext['callId'] }
}
