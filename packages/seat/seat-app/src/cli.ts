/** Explicit seat CLI parsing delegates all window policy to SeatService. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import { decodeSeatRequest, isSeatMethod, type SeatRequestMap } from '@panedesk/dsh-sdk-protocol'
import type { SeatCallContext } from '@panedesk/dsh-seat'

/** A parsed operation retains its validated wire fields. */
export type SeatCommand = { [M in keyof SeatRequestMap]: { method: M; request: SeatRequestMap[M]['params'] } }[keyof SeatRequestMap]

/** Parse explicit CLI names; no wildcard can expand a catalog.
 * @param args - command and long options.
 * @returns validated request with a caller-visible operation identity.
 */
export function parseSeatArgs(args: readonly string[]): SeatCommand {
  const action = args[0] ?? 'list'
  const flags = new Map<string, string>()
  for (let i = 1; i < args.length; i++) {
    const flag = args[i] ?? ''
    if (!flag.startsWith('--') || flags.has(flag)) throw new Error('Invalid seat options')
    const value = flag === '--json' ? 'true' : args[++i]
    if (!value || value.startsWith('--')) throw new Error('Missing seat option value')
    flags.set(flag, value)
  }
  const method = `seats/${action === 'open' && flags.has('--seats') ? 'openBatch' : action}`
  if (!isSeatMethod(method)) throw new Error('Unknown seat command')
  const names: Record<string, string> = { '--seat': 'seat', '--seats': 'seats', '--session': 'sessionId', '--node': 'nodeId',
    '--project': 'projectId', '--operation': 'operationId', '--opening': 'openingMode', '--title': 'title',
    '--state-version': 'expectedStateVersion', '--revision': 'expectedRevision', '--limit': 'limit', '--cursor': 'cursor',
    '--queue-item': 'queueItemId', '--mode': 'mode', '--gate': 'gateId', '--task': 'taskId' }
  const encoded = flags.get('--request')
  if (encoded !== undefined) {
    if ([...flags.keys()].some(flag => flag !== '--request' && flag !== '--json')) throw new Error('JSON request cannot be combined with field options')
    return { method, request: decodeSeatRequest(method, JSON.parse(encoded)) } as SeatCommand
  }
  const request: Record<string, unknown> = {}
  for (const [flag, value] of flags) {
    if (flag === '--json') continue
    const key = names[flag]
    if (!key) throw new Error('Unknown seat option')
    request[key] = ['expectedStateVersion', 'expectedRevision', 'limit'].includes(key) ? Number(value)
      : key === 'seats' ? [...new Set(value.split(',').map(name => name.trim()))] : value
  }
  if (['open', 'openBatch', 'renew', 'close', 'replace', 'rename', 'wake', 'setProjectMode', 'approve', 'cancel'].some(name => method === `seats/${name}`)) {
    request.operationId ??= randomUUID()
  }
  if (method === 'seats/open' || method === 'seats/openBatch') {
    request.origin = 'manual'
    request.openingMode ??= 'prefill'
  }
  if (['seats/pending', 'seats/gates'].includes(method)) request.limit ??= 100
  return { method, request: decodeSeatRequest(method, request) } as SeatCommand
}

/** Run one command with trusted launcher identity, never a wire-supplied principal.
 * @param ctx - launcher-owned service context.
 * @param args - untrusted command arguments.
 * @returns printable result and process status.
 */
export async function executeSeatCommand(ctx: Context, args: readonly string[]): Promise<{ code: number; output: unknown }> {
  let command: SeatCommand
  try { command = parseSeatArgs(args) } catch (error) {
    void error
    return { code: 2, output: { status: 'rejected', error: { code: 'invalid-request', message: 'Invalid seat command; provide explicit targets and required versions.' } } }
  }
  const seats = ctx.get('seats'), engine = ctx.get('seatEngine')
  if (!seats || !engine) return { code: 2, output: { status: 'rejected', error: { code: 'unavailable' } } }
  const status = await engine.nodeStatus()
  const authority: SeatCallContext = { principalId: 'owner' as SeatCallContext['principalId'], origin: 'manual', nodeId: status.nodeId }
  const service = seats.withAuthority(authority)
  let output: unknown
  switch (command.method) {
    case 'seats/import.preview': output = await service.previewImport(command.request); break
    case 'seats/import.commit': output = await service.commitImport(command.request); break
    case 'seats/setAuthority': output = await service.setAuthority(command.request); break
    case 'seats/report.submit': output = await service.submitReport(command.request); break
    case 'seats/wait.register': output = await service.registerWait(command.request); break
    case 'seats/wait.cancel': output = await service.cancelWait(command.request); break
    case 'seats/list': output = await service.list(command.request); break
    case 'seats/open': output = await service.open(command.request); break
    case 'seats/openBatch': output = await service.openBatch(command.request); break
    case 'seats/renew': output = await service.renew(command.request); break
    case 'seats/close': output = await service.close(command.request); break
    case 'seats/replace': output = await service.replace(command.request); break
    case 'seats/rename': output = await service.rename(command.request); break
    case 'seats/wake': output = await service.wake(command.request); break
    case 'seats/binding': output = await service.binding(command.request); break
    case 'seats/operation': output = await service.operation(command.request); break
    case 'seats/setProjectMode': output = await engine.setProjectMode(command.request); break
    case 'seats/pending': output = await engine.pending(command.request); break
    case 'seats/approve': output = await engine.approve(command.request); break
    case 'seats/cancel': output = await engine.cancel(command.request); break
    case 'seats/nodeStatus': output = status; break
    case 'seats/gates': {
      const gates = ctx.get('seatGates')
      output = gates ? await gates.list(command.request) : { status: 'rejected', error: { code: 'unavailable' } }
      break
    }
  }
  const failed = output !== null && typeof output === 'object' && 'status' in output
    && ['rejected', 'busy', 'conflict', 'failed', 'uncertain'].includes(String(output.status))
  return { code: failed ? 2 : 0, output }
}
