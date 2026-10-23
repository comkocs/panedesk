/** Nonblocking wait tools retain the caller's execution identity. */
import type { Context } from '@panedesk/cordis'
import { defineTool } from '@panedesk/dsh-tools'
import type { SeatOperationId, WaitId, WaitObject } from '@panedesk/dsh-seat'

/** Register observation without polling or sleeping.
 * @param ctx - optional seat service and owning tool registry.
 */
export function registerWaitTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'seat_wait',
    description: 'Wait for any or all named pending objects. Registration returns immediately and ends this turn; completion wakes you. Do not sleep or poll while waiting.',
    parameters: {
      mode: { type: 'string', enum: ['any', 'all'], required: true },
      objects: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', enum: ['subagent', 'job', 'schedule', 'message'], required: true },
          id: { type: 'string', required: true },
        },
      } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const seats = ctx.get('seats')
      if (seats === undefined || exec.agent === undefined) throw new Error('Seat waiting requires an available seat service and a calling Session.')
      if (args.objects.length === 0 || args.objects.some(object => object.id.length === 0)) throw new Error('Name at least one pending object.')
      const result = await seats.registerWait({
        waitId: `tool:${exec.agent.session.id}:${exec.callId}` as WaitId,
        operationId: `tool:${exec.agent.session.id}:${exec.callId}` as SeatOperationId,
        sessionId: exec.agent.session.id, mode: args.mode,
        objects: args.objects as WaitObject[], toolCallId: exec.callId, rootCallId: exec.rootCallId,
      })
      if (result.status === 'registered') exec.concludeTurn()
      return JSON.stringify(result)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'seat_cancel_wait', description: 'Cancel your wait registration without cancelling the underlying tasks.',
    parameters: {
      waitId: { type: 'string', required: true },
      expectedStateVersion: { type: 'integer', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const seats = ctx.get('seats')
      if (seats === undefined || exec.agent === undefined) throw new Error('Seat waiting is unavailable.')
      return JSON.stringify(await seats.cancelWait({ ...args, waitId: args.waitId as WaitId,
        sessionId: exec.agent.session.id, operationId: `tool:${exec.agent.session.id}:${exec.callId}` as SeatOperationId }))
    },
  }))
}
