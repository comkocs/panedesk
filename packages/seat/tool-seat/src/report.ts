/** Explicit three-part close reports never claim runtime idleness. */
import type { Context } from '@panedesk/cordis'
import { defineTool } from '@panedesk/dsh-tools'
import type { CloseReportId, SeatOperationId } from '@panedesk/dsh-seat'

/** Register attributed close reporting and revocation.
 * @param ctx - tool owner and optional seat service.
 */
export function registerReportTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'seat_report', description: 'Report whether you can close, what you are waiting for, and when to open next. A report does not close a busy window.',
    parameters: {
      canClose: { type: 'boolean', required: true },
      waitingFor: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', enum: ['subagent', 'job', 'schedule', 'message', 'other'], required: true },
          objectId: { type: 'string' }, summary: { type: 'string', required: true },
        },
      } },
      nextOpen: { type: 'object', additionalProperties: false, required: true, properties: {
        when: { required: true, oneOf: [
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'unspecified', required: true } } },
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'at', required: true }, at: { type: 'string', required: true } } },
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'condition', required: true }, description: { type: 'string', required: true } } },
        ] },
        prerequisites: { type: 'array', items: { type: 'string' }, required: true },
      } },
      stateVersion: { type: 'integer', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const seats = exec.agent === undefined ? undefined : ctx.get('seatLocalSession')?.forSession(exec.agent.session)
      if (seats === undefined || exec.agent === undefined) throw new Error('Seat reporting is unavailable.')
      if (args.nextOpen.when.kind === 'at' && !Number.isFinite(Date.parse(args.nextOpen.when.at))) throw new Error('Supply a valid next-open timestamp.')
      return JSON.stringify(await seats.submitReport({
        report: { ...args, reportId: `tool:${exec.agent.session.id}:${exec.callId}` as CloseReportId,
          sessionId: exec.agent.session.id, submittedAt: new Date().toISOString() },
        operationId: `tool:${exec.agent.session.id}:${exec.callId}` as SeatOperationId,
        toolCallId: exec.callId, rootCallId: exec.rootCallId,
      }))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'seat_revoke_report', description: 'Revoke your earlier close report by its current state version.',
    parameters: { reportId: { type: 'string', required: true }, expectedStateVersion: { type: 'integer', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const seats = exec.agent === undefined ? undefined : ctx.get('seatLocalSession')?.forSession(exec.agent.session)
      if (seats === undefined || exec.agent === undefined) throw new Error('Seat reporting is unavailable.')
      return JSON.stringify(await seats.revokeReport({ ...args, reportId: args.reportId as CloseReportId,
        sessionId: exec.agent.session.id, operationId: `tool:${exec.agent.session.id}:${exec.callId}` as SeatOperationId }))
    },
  }))
}
