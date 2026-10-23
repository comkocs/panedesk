import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import type { UserMessage } from '@panedesk/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@panedesk/dsh-session'
import type { EngineEffect } from '../src/index.ts'
import type { OpenSeatRequest, OpenSeatResult, SeatService } from '../src/index.ts'

/** Wait for this opening's queue decision before replaying its retained outcome.
 * @param ctx - context publishing committed engine decisions.
 * @param seats - authorized opening service.
 * @param request - unchanged opening identity for submission and replay.
 * @returns the opening outcome after its pending item leaves the queue.
 */
export async function settlesOpening(ctx: Context, seats: SeatService, request: OpenSeatRequest): Promise<OpenSeatResult> {
  const settled = Promise.withResolvers<undefined>()
  const cancelled = new Set<string>()
  let queued: string | undefined
  const off = ctx.on('seat/decision', (decision) => {
    for (const effect of decision.effects) {
      if (effect.kind === 'queue/cancelled') cancelled.add(effect.data.pending.queueItemId)
    }
    if (queued !== undefined && cancelled.has(queued)) settled.resolve(undefined)
  })
  const { onTestFinished } = await import('vitest')
  onTestFinished(off)
  try {
    const result = await seats.open(request)
    if (result.status !== 'queued') return result
    queued = result.queueItemId
    if (!cancelled.has(queued)) await settled.promise
    return await seats.open(request)
  } finally { off() }
}

/** Run an operation after subscribing to its input's completed turn.
 * @param ctx - context carrying session events.
 * @param sessionId - target session identity.
 * @param matches - identifies the operation's admitted input.
 * @param action - operation that produces the input.
 * @returns the result after the turn completes and M5 inputs have durable response receipts.
 */
export async function completesTurn<T>(ctx: Context, sessionId: SessionId | ((id: SessionId) => boolean),
  matches: (message: UserMessage) => boolean, action: () => Promise<T>): Promise<T> {
  const completed = Promise.withResolvers<undefined>()
  const turns = new Map<SessionId, number>()
  let input: { sessionId: SessionId; turn: number; message: UserMessage } | undefined
  let ended = false
  const responded = new Set<string>()
  const settle = () => {
    if (ended && input && (input.message.source.kind !== 'message-delivery' || responded.has(input.message.id))) {
      completed.resolve(undefined)
    }
  }
  const offReceipt = ctx.on('message/state', (event) => {
    if (event.data.state !== 'responded') return
    responded.add(event.data.messageId)
    settle()
  })
  const observe = (session: Session, event: SessionEvent) => {
    if (typeof sessionId === 'function' ? !sessionId(session.id) : session.id !== sessionId) return
    if (event.type === 'turn/start') turns.set(session.id, event.data.turn)
    const turn = turns.get(session.id)
    if (event.type === 'user/message' && matches(event.data) && turn !== undefined) input = { sessionId: session.id, turn, message: event.data }
    if (event.type !== 'turn/end' || session.id !== input?.sessionId || event.data.turn !== input.turn) return
    if (event.data.reason.kind === 'completed') { ended = true; settle() }
    else completed.reject(new Error(`Input turn ended with ${event.data.reason.kind}`))
  }
  const off = ctx.on('session/event', observe)
  const { onTestFinished } = await import('vitest')
  onTestFinished(() => { off(); offReceipt() })
  try {
    const [result] = await Promise.all([action(), completed.promise])
    return result
  } finally { off(); offReceipt() }
}

/** Match an exact text fragment in a model-visible input.
 * @param text - operation-specific input text.
 * @returns a predicate for the admitted user message.
 */
export function inputContains(text: string): (message: UserMessage) => boolean {
  return message => message.content.some(block => block.type === 'text' && block.text.includes(text))
}

/** Subscribe before an operation and wait for its durable inbox insertion.
 * @param ctx - context carrying input events.
 * @param sessionId - target session.
 * @param matches - identifies the queued input.
 * @param action - operation publishing that input.
 * @returns the operation result once the input is inserted.
 */
export async function insertsInput<T>(ctx: Context, sessionId: SessionId,
  matches: (message: UserMessage) => boolean, action: () => Promise<T>): Promise<T> {
  const inserted = Promise.withResolvers<undefined>()
  const off = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent.id === sessionId && matches(message)) inserted.resolve(undefined)
  })
  const { onTestFinished } = await import('vitest')
  onTestFinished(() => { off() })
  try {
    const [result] = await Promise.all([action(), inserted.promise])
    return result
  } finally { off() }
}

/** Await a committed engine effect produced by an operation.
 * @param ctx - context carrying engine decisions.
 * @param matches - identifies the committed effect.
 * @param action - operation producing it.
 * @returns the operation result after the decision notification.
 */
export async function commitsEffect<T>(ctx: Context, matches: (effect: EngineEffect) => boolean,
  action: () => Promise<T>): Promise<T> {
  const committed = Promise.withResolvers<undefined>()
  const off = ctx.on('seat/decision', (decision) => {
    if (decision.effects.some(matches)) committed.resolve(undefined)
  })
  const { onTestFinished } = await import('vitest')
  onTestFinished(() => { off() })
  try {
    const [result] = await Promise.all([action(), committed.promise])
    return result
  } finally { off() }
}

/** Wait for a local seat provider to be published, without polling startup effects.
 * @param ctx - context receiving the provider.
 * @returns after the service injection becomes available.
 */
export async function seatsReady(ctx: Context): Promise<void> {
  let off: (() => Promise<void>) | undefined
  try {
    await new Promise<void>((resolve) => {
      const fiber = ctx.inject(['seats'], () => { resolve() })
      off = () => fiber.dispose()
    })
  } finally { await off?.() }
}

/** Wait for the owned input interval to reach idle after a committed turn end.
 * @param ctx - event subscription owner.
 * @param agent - exact live agent driven by this test.
 * @param dispatch - synchronous input dispatch after listeners are installed.
 * @returns completion after a committed turn end and idle, with bounded failure diagnostics.
 */
export async function completesIdleTurn(ctx: Context, agent: Agent, dispatch: () => void): Promise<void> {
  const completed = Promise.withResolvers<undefined>()
  let ended = false
  const off = ctx.on('session/event', (session, event) => {
    if (session.id === agent.id && event.type === 'turn/end') ended = true
  })
  const offStatus = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject.id === agent.id && status === 'idle' && ended) completed.resolve(undefined)
  })
  const timer = setTimeout(() => { completed.reject(new Error(`Turn completion timed out: ${agent.id}; ended=${ended}`)) }, 10000)
  try { dispatch(); await completed.promise }
  finally { clearTimeout(timer); offStatus(); off() }
}
