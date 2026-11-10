/** Model-facing project trace operations over the Host-owned trace service. */
import type { Context } from '@panedesk/cordis'
import { defineTool } from '@panedesk/dsh-tools'
import type { ToolRunContext } from '@panedesk/dsh-tools'
import type {} from '@panedesk/dsh-agent'
import type {} from '@panedesk/dsh-system-prompt'
import type { DecisionId, ReferenceId, WorkspaceRequest } from '@panedesk/dsh-trace-store'

/** Loader identity. */
export const name = 'tool-trace'
/** Every operation uses the current Agent and the existing project service. */
export const inject = ['tools', 'agents', 'systemPrompt', 'traceStore']

const disabled = 'This project has not enabled trace recording; ask the user to enable it in workspace settings. / 本项目没开事项记录,请用户在工作区设置里打开'
const output = {
  schema: { type: 'string' },
  render: (_args: object, value: string) => [{ type: 'text' as const, text: value }],
} as const

/** Register trace tools and a replayable prompt section in the mounting scope.
 * @param ctx Tool registry, Agent initiator scope, prompt assembly, and project service.
 */
export function apply(ctx: Context): void {
  const invoke = async (exec: ToolRunContext, operation: (request: WorkspaceRequest) => unknown): Promise<string> => {
    exec.signal.throwIfAborted()
    const agent = exec.agent
    if (agent === undefined) throw new Error('Trace tools require a current session')
    const workspaceId = await ctx.traceStore.workspaceForSession(agent.session.id)
    if (workspaceId === undefined || !ctx.traceStore.status({ workspaceId }).enabled) return disabled
    const request = { workspaceId, sessionId: agent.session.id }
    return ctx.agents.withInitiator(agent, async () => JSON.stringify(await operation(request) ?? { ok: true }))
  }
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.agent !== undefined) {
      const workspaceId = await ctx.traceStore.workspaceForSession(context.agent.session.id)
      if (workspaceId !== undefined && ctx.traceStore.status({ workspaceId }).enabled) {
        assembly.sections.push({ name: 'project-trace', interpolate: false,
          text: 'This project records activity: at the start of work, use trace_link_session to associate this session with the relevant item, and record decisions with trace_decision.' })
      }
    }
    return assembly
  })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'trace_items',
    description: 'List project items, create an item, or close an item while retaining its history. Uses the current session project; recording must be enabled by the user.',
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'close'], required: true, description: 'list returns all items; create needs title; close needs item_id.' },
      title: { type: 'string', description: 'Title for create; unused for list and close.' },
      item_id: { type: 'integer', description: 'Existing item number for close; unused for list and create.' },
    },
    output,
    isConcurrencySafe: args => args.action === 'list',
    execute: (args, exec) => invoke(exec, request => {
      switch (args.action) {
        case 'list': return ctx.traceStore.listItems(request)
        case 'create':
          if (args.title === undefined) throw new Error('title is required for create')
          return ctx.traceStore.createItem({ ...request, title: args.title })
        case 'close':
          if (args.item_id === undefined) throw new Error('item_id is required for close')
          return ctx.traceStore.closeItem({ ...request, itemId: args.item_id })
      }
    }),
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'trace_timeline',
    description: 'Read a project item timeline or unassigned activity, including reference metadata and an exclusive continuation cursor.',
    parameters: {
      item_id: { type: 'integer', description: 'Item number; omit to read only unassigned activity.' },
      cursor: { type: 'integer', description: 'Last event number from the previous page; omit to start at the beginning.' },
      limit: { type: 'integer', description: 'Number of events per page; defaults to 100.' },
    },
    output,
    isConcurrencySafe: () => true,
    execute: (args, exec) => invoke(exec, request => ctx.traceStore.timeline({ ...request, itemId: args.item_id ?? null,
      ...args.cursor === undefined ? {} : { cursor: args.cursor }, ...args.limit === undefined ? {} : { limit: args.limit } })),
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'trace_read_ref',
    description: 'Read the original session excerpt or durable change diff for a timeline reference. Attachment references return their recorded pointer, not file contents.',
    parameters: { reference_id: { type: 'string', required: true, description: 'Exact reference id returned by trace_timeline.' } },
    output,
    isConcurrencySafe: () => true,
    execute: (args, exec) => invoke(exec, request => ctx.traceStore.readReference({ ...request, referenceId: args.reference_id as ReferenceId })),
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'trace_comment',
    description: 'Append a comment to a project item with automatic session and model attribution.',
    parameters: {
      item_id: { type: 'integer', required: true, description: 'Item number receiving the comment.' },
      body: { type: 'string', required: true, description: 'Comment text to append.' },
    },
    output,
    execute: (args, exec) => invoke(exec, request => ctx.traceStore.comment({ ...request, itemId: args.item_id, body: args.body })),
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'trace_link_session',
    description: 'Associate the current session and subsequent descendant activity with a project item. Does not change the working directory.',
    parameters: { item_id: { type: 'integer', required: true, description: 'Item number to associate with this current session.' } },
    output,
    execute: (args, exec) => invoke(exec, request => ctx.traceStore.linkSession({ ...request, itemId: args.item_id, targetSessionId: request.sessionId! })),
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'trace_decision',
    description: 'Read active project decisions, read immutable history, or write a decision revision. Normally writes become active immediately. In strict mode only the designated planning session may write, and its writes are proposals requiring user confirmation. No tool can confirm proposals or change verification settings.',
    parameters: {
      action: { type: 'string', enum: ['current', 'history', 'write'], required: true, description: 'current lists active revisions; history lists revisions; write appends a revision.' },
      decision_id: { type: 'string', description: 'For history, filter to this decision; omit for all history. For write, revise this decision; omit to create one. Unused for current.' },
      item_id: { type: 'integer', description: 'Item associated with a write; omit for an unassigned decision. Unused for reads.' },
      title: { type: 'string', description: 'Decision title, required for write and unused for reads.' },
      body: { type: 'string', description: 'Decision text, required for write and unused for reads.' },
    },
    output,
    isConcurrencySafe: args => args.action !== 'write',
    execute: (args, exec) => invoke(exec, request => {
      switch (args.action) {
        case 'current': return ctx.traceStore.listDecisions(request)
        case 'history': return ctx.traceStore.decisionHistory({ ...request,
          ...args.decision_id === undefined ? {} : { decisionId: args.decision_id as DecisionId } })
        case 'write':
          if (args.title === undefined || args.body === undefined) throw new Error('title and body are required for write')
          return ctx.traceStore.writeDecision({ ...request, itemId: args.item_id ?? null, title: args.title, body: args.body,
            ...args.decision_id === undefined ? {} : { decisionId: args.decision_id as DecisionId } })
      }
    }),
  })))
}
