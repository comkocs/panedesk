/** Read-only dispatch keeps engine frames out of the accounting journal reader. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-seat'
import type { EngineCommand } from './engine-cli.ts'

/** Dispatch to optional engine readers without creating a runtime or importing events.
 * @param ctx - owning query context.
 * @param command - validated engine operation.
 * @returns structured output and a nonzero status for unavailable or rejected reads.
 */
export async function executeEngine(ctx: Context, command: EngineCommand): Promise<{ code: number; output: unknown }> {
  const engine = ctx.get('seatEngineQuery') ?? ctx.get('seatEngine'), gates = ctx.get('seatGatesQuery') ?? ctx.get('seatGates')
  const unavailable = { code: 2, output: { status: 'rejected', error: { code: 'unavailable',
    message: 'The engine query provider is unavailable.', alternative: 'Install the read-only engine provider.', retryable: true, effectState: 'none' } } }
  if (command.action === 'gates') {
    if (!gates) return unavailable
    const output = await gates.list(command.request)
    return { code: 'status' in output ? 2 : 0, output }
  }
  if (!engine) return unavailable
  switch (command.action) {
    case 'events': {
      const output = await engine.query(command.request)
      return { code: 'status' in output ? 2 : 0, output }
    }
    case 'pending': {
      const output = await engine.pending(command.request)
      return { code: 'status' in output ? 2 : 0, output }
    }
    case 'export': {
      const output = await engine.export(command.request)
      return { code: output.status === 'rejected' ? 2 : 0, output }
    }
    case 'verify': {
      const output = await engine.verify(command.request)
      return { code: output.status === 'rejected' ? 2 : 0, output }
    }
  }
}
