/** Subscribe before dispatch and settle only from observable completion. */
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'

/** Wait for the owned input interval to reach idle after a committed turn end.
 * @param ctx - event subscription owner.
 * @param agent - exact live agent driven by this test.
 * @param dispatch - synchronous input dispatch after listeners are installed.
 * @returns completion after a committed turn end and idle, with bounded failure diagnostics.
 */
export async function completeTurn(ctx: Context, agent: Agent, dispatch: () => void): Promise<void> {
  const completion = Promise.withResolvers<undefined>()
  let ended = false
  const offEvent = ctx.on('session/event', (session, event) => {
    if (session.id === agent.id && event.type === 'turn/end') ended = true
  })
  const offStatus = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject.id === agent.id && status === 'idle' && ended) completion.resolve(undefined)
  })
  const timer = setTimeout(() => { completion.reject(new Error(`Turn completion timed out: ${agent.id}; ended=${ended}`)) }, 10000)
  try { dispatch(); await completion.promise }
  finally { clearTimeout(timer); offStatus(); offEvent() }
}
