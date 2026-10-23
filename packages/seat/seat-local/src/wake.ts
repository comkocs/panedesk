/** Wake selects one explicit active target or delegates to the unified opening path. */
import type { OpenSeatRequest, OpenSeatResult, SeatDefinition, SeatOperationId, SeatWindowCandidate, WakeSeatRequest, WakeSeatResult } from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import { rejected } from './errors.ts'
import { readSeatText, renderOpening } from './template.ts'

/** Delivery retains its operation identity and cannot lift a budget barrier. */
export interface WakeRuntime {
  resolve(seat: SeatDefinition['seat']): Promise<SeatDefinition | ReturnType<typeof rejected>>
  candidates(seat: SeatDefinition['seat']): Promise<readonly SeatWindowCandidate[]>
  open(request: OpenSeatRequest): Promise<OpenSeatResult>
  send(request: { sessionId: SessionId; operationId: SeatOperationId; text: string; messageClass: 'handoff'; mode: 'queue' }): Promise<Extract<WakeSeatResult, { status: 'sent' | 'stored-budget-stopped' }>>
  freeze(operationId: SeatOperationId, render: () => Promise<string>): Promise<string>
  date(): string
  maxTextBytes: number
  origin: OpenSeatRequest['origin']
}

/** Use the catalog's wake text for an active seat, never opening a second window implicitly.
 * @param runtime - authenticated local capabilities.
 * @param request - exact seat and optional window selection.
 * @returns sent, candidate choices, delegated open or refusal.
 */
export async function wakeWindow(runtime: WakeRuntime, request: WakeSeatRequest): Promise<WakeSeatResult> {
  const definition = await runtime.resolve(request.seat)
  if ('status' in definition) return definition
  const candidates = await runtime.candidates(request.seat)
  if (candidates.length === 0) {
    if (request.sessionId !== undefined) return rejected('session-not-found', 'The selected window is not active.', 'List the active windows before waking one.')
    return { status: 'opened', result: await runtime.open({ seat: request.seat, operationId: request.operationId, origin: runtime.origin,
      ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }), openingMode: 'auto' }) }
  }
  const target = request.sessionId === undefined ? candidates.length === 1 ? candidates[0] : undefined
    : candidates.find(item => item.sessionId === request.sessionId)
  if (target === undefined) return request.sessionId === undefined ? { status: 'choice-required', candidates }
    : rejected('session-not-found', 'The selected window does not belong to this active seat.', 'Select a listed window.')
  if (definition.wakeTemplate === undefined) return rejected('wake-template-missing', 'This seat has no wake template.', 'Configure a wake template in the authoritative seat source.')
  const source = definition.wakeTemplate
  const text = await runtime.freeze(request.operationId, async () => renderOpening(await readSeatText(source, runtime.maxTextBytes),
    { seat: definition.seat, date: runtime.date(), taskId: null }, runtime.maxTextBytes).text)
  return runtime.send({ sessionId: target.sessionId, operationId: request.operationId, text, messageClass: 'handoff', mode: 'queue' })
}
