/** Executor-owned attribution; model arguments cannot select sender identity or a group. */
import { createHash } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import { defineTool } from '@panedesk/dsh-tools'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import type {} from '@panedesk/dsh-seat'
import type {} from '@panedesk/dsh-agent'

/** Register single-seat sending and read-only online observations.
 * @param ctx - injected provider and tool lifecycle.
 */
export function registerSeatMessageTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'seat_send',
    description: 'Send text to one open seat on this node. A busy recipient reads it at the next tool-step boundary; an idle recipient starts a turn when handoff wake is enabled. Never opens a closed seat. No broadcast or wildcard targets.',
    parameters: {
      seat: { type: 'string', required: true, description: 'One exact local seat name.' },
      text: { type: 'string', required: true, description: 'Message text.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent || ctx.agents.get(agent.id) !== agent) throw new Error('seat_send requires a live calling Session')
      if (!args.seat.trim() || /[*?]/.test(args.seat) || !args.text.trim()) throw new Error('One exact seat and non-empty text are required')
      const delivery = ctx.messageDelivery
      if (!delivery.resolveSeat) throw new Error('Seat addressing is unavailable')
      const target = await delivery.resolveSeat(args.seat)
      if (target.kind === 'rejected') return JSON.stringify(target)
      const binding = await ctx.seatLocalRead.binding({ sessionId: agent.id })
      if (binding && 'status' in binding) throw new Error(binding.error.message)
      let sender: string
      if (binding?.kind === 'seat') sender = `Seat ${JSON.stringify(binding.seat)}`
      else {
        const [self] = await delivery.resolve([{ sessionId: agent.id }])
        if (self?.kind !== 'resolved') throw new Error('Sender Session name is unavailable')
        sender = `Free window ${JSON.stringify(self.recipient.title ?? self.recipient.window ?? agent.id)}`
      }
      return ctx.agents.withInitiator(agent, async () => JSON.stringify(await delivery.send({
        target: { nodeId: target.recipient.nodeId, sessionId: target.recipient.sessionId },
        content: `${sender}:\n${args.text}`, messageClass: 'handoff', priority: 'steer',
        operationId: `seat-send-${createHash('sha256').update(JSON.stringify([agent.id, exec.callId])).digest('hex')}` as OperationId,
      })))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'seat_list_online',
    description: 'List open local seats with their Session, node, primary-window selection, and current busy or idle state. Observations do not reserve delivery.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const delivery = ctx.messageDelivery
      if (!delivery.listOnlineSeats) throw new Error('Online seat queries are unavailable')
      return JSON.stringify(await delivery.listOnlineSeats())
    },
  }))
}
