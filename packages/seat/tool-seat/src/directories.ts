/** Additional-root tools delegate permission and memory ownership to the directory provider. */
import type { Context } from '@panedesk/cordis'
import { defineTool, type ToolRunContext } from '@panedesk/dsh-tools'
import type { SeatDirectoryRoot, SeatOperationId } from '@panedesk/dsh-seat'

function directoryInvocation(ctx: Context, exec: ToolRunContext) {
  const directories = ctx.get('seatDirectories')
  if (directories === undefined || exec.agent === undefined) throw new Error('Seat directories are unavailable.')
  return { directories, sessionId: exec.agent.session.id }
}

/** Register root-selected reads and writes without widening shell permissions.
 * @param ctx - registry owner and optional directory provider.
 */
export function registerDirectoryTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'seat_directories', description: 'List your registered directory roots and their effective write permissions. These permissions do not change shell access.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      const { directories, sessionId } = directoryInvocation(ctx, exec)
      return JSON.stringify(await directories.roots(sessionId))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'seat_read', description: 'Read a relative path within one of your registered roots. Truncation is reported explicitly.',
    parameters: {
      rootId: { type: 'string', required: true }, relativePath: { type: 'string', required: true },
      maxBytes: { type: 'integer', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const { directories, sessionId } = directoryInvocation(ctx, exec)
      if (args.maxBytes <= 0) throw new Error('maxBytes must be positive.')
      return JSON.stringify(await directories.read({ ...args, sessionId,
        rootId: args.rootId as SeatDirectoryRoot['rootId'] }))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'seat_write', description: 'Write within a registered root. Memory ownership, filesystem permissions and approvals still apply.',
    parameters: {
      rootId: { type: 'string', required: true }, relativePath: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const { directories, sessionId } = directoryInvocation(ctx, exec)
      return JSON.stringify(await directories.write({ ...args, sessionId,
        rootId: args.rootId as SeatDirectoryRoot['rootId'],
        operationId: `tool:${sessionId}:${exec.callId}` as SeatOperationId }))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'seat_edit', description: 'Replace exact text within a registered root under the same permissions as seat_write.',
    parameters: {
      rootId: { type: 'string', required: true }, relativePath: { type: 'string', required: true },
      oldText: { type: 'string', required: true }, newText: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const { directories, sessionId } = directoryInvocation(ctx, exec)
      return JSON.stringify(await directories.edit({ ...args, sessionId,
        rootId: args.rootId as SeatDirectoryRoot['rootId'],
        operationId: `tool:${sessionId}:${exec.callId}` as SeatOperationId }))
    },
  }))
}
