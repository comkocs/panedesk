/** Window tools call the node-local seat provider rather than creating Sessions directly. */
import type { Context } from '@panedesk/cordis'
import { defineTool } from '@panedesk/dsh-tools'
import type { SeatName, SeatOperationId } from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'

/** Register explicit window operations with stable tool operation IDs.
 * @param ctx - registry owner and optional seat provider.
 */
export function registerWindowTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'seat_windows', description: 'List local windows, their runtime busy reasons and state versions, plus unopened seats.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const seats = ctx.get('seatLocalRead')
      if (seats === undefined) throw new Error('Seat windows are unavailable.')
      return JSON.stringify(await seats.list({}))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'seat_open', description: 'Open one explicitly named local seat. Existing windows and admission limits remain enforced.',
    parameters: { seat: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const seats = ctx.get('seats')
      if (seats === undefined || exec.agent === undefined) throw new Error('Seat windows are unavailable.')
      return JSON.stringify(await seats.open({ seat: args.seat as SeatName, origin: 'manual', openingMode: 'auto',
        operationId: `tool:${exec.agent.session.id}:${exec.callId}` as SeatOperationId }))
    },
  }))
  for (const action of ['renew', 'replace', 'close', 'rename'] as const) {
    ctx.tools.register(defineTool({
      name: `seat_${action}`, description: `${action} an explicitly selected local window. Closing refuses busy windows; replacement opens new before closing old.`,
      parameters: {
        sessionId: { type: 'string', required: true },
        expectedStateVersion: { type: 'integer' }, title: { type: 'string' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const seats = ctx.get('seats')
        if (seats === undefined || exec.agent === undefined) throw new Error('Seat windows are unavailable.')
        const request = { sessionId: args.sessionId as SessionId,
          operationId: `tool:${exec.agent.session.id}:${exec.callId}` as SeatOperationId }
        if (action === 'close') {
          if (args.expectedStateVersion === undefined) throw new Error('Closing requires expectedStateVersion from seat_windows.')
          return JSON.stringify(await seats.close({ ...request, expectedStateVersion: args.expectedStateVersion }))
        }
        if (action === 'rename') {
          if (args.title === undefined) throw new Error('Renaming requires a title.')
          return JSON.stringify(await seats.rename({ ...request, title: args.title }))
        }
        return JSON.stringify(await seats[action](request))
      },
    }))
  }
  ctx.tools.register(defineTool({
    name: 'seat_wake', description: 'Send the configured wake text to a seat, or open it if unopened. Select a window explicitly when several exist.',
    parameters: { seat: { type: 'string', required: true }, sessionId: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const seats = ctx.get('seats')
      if (seats === undefined || exec.agent === undefined) throw new Error('Seat windows are unavailable.')
      return JSON.stringify(await seats.wake({ seat: args.seat as SeatName,
        ...args.sessionId === undefined ? {} : { sessionId: args.sessionId as SessionId },
        operationId: `tool:${exec.agent.session.id}:${exec.callId}` as SeatOperationId }))
    },
  }))
}
