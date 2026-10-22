/** Input checkpoints attached only to declared agent and session events. */
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import { createTestGate, type TestGate } from './controls.ts'

/** Four independently addressable points in one agent's request lifecycle. */
export type InputBarrierName = 'beforePrepare' | 'claimedPrepare' | 'appended' | 'streamEntered'

/** A synchronous checkpoint plus an optional asynchronous wait owned by the producer. */
export interface InputCheckpoint extends TestGate {
  /** Publish checkpoint entry without yielding in a synchronous event. */
  enter(): void
}

/** Scenario-local checkpoints and their context listener disposer. */
export interface InputBarriers {
  /** Before any claim, on agent/input-preparing. */
  readonly beforePrepare: InputCheckpoint
  /** After claim, while the agent/request preparation waterfall is suspended. */
  readonly claimedPrepare: InputCheckpoint
  /** After durable appended transition, before stream entry; notification is synchronous. */
  readonly appended: InputCheckpoint
  /** After the synchronous agent/input-dispatching commit. */
  readonly streamEntered: InputCheckpoint
  /** Release every waiter and remove this registration's listeners. */
  dispose(): void
}

function checkpoint(): InputCheckpoint {
  const gate = createTestGate()
  const entered = Promise.withResolvers<void>()
  return {
    reached: entered.promise,
    enter() { entered.resolve() },
    wait(signal) {
      entered.resolve()
      return gate.wait(signal)
    },
    release: () => { gate.release() },
  }
}

/**
 * Attach checkpoints to one agent without replacing the Session or loop.
 * Only the preparation events await release. Synchronous checkpoints can run
 * a synchronous fault callback; they never insert an await into dispatch.
 * Tests driving event producers may explicitly await their checkpoint.wait().
 * @param ctx - context owning listeners and their automatic disposal.
 * @param agent - exact agent to observe; parent and children use separate registrations.
 * @param onSynchronous - optional appended/stream-entry callback, including fault injection.
 * @returns checkpoints that the test must release or dispose during teardown.
 */
export function mountInputBarriers(
  ctx: Context,
  agent: Agent,
  onSynchronous?: (point: 'appended' | 'streamEntered') => void,
): InputBarriers {
  const beforePrepare = checkpoint()
  const claimedPrepare = checkpoint()
  const appended = checkpoint()
  const streamEntered = checkpoint()
  const stops = [
    ctx.on('agent/input-preparing', async (payload) => {
      if (payload.agent === agent) await beforePrepare.wait(payload.signal)
    }),
    ctx.on('agent/request', async (payload, next) => {
      if (payload.agent === agent) await claimedPrepare.wait(payload.signal)
      return next()
    }),
    ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'agent/input/transition') return
      if (event.data.phase === 'claimed') claimedPrepare.enter()
      if (event.data.phase === 'appended') {
        appended.enter()
        onSynchronous?.('appended')
      }
    }),
    ctx.on('agent/input-dispatching', (payload) => {
      if (payload.agent !== agent) return
      streamEntered.enter()
      onSynchronous?.('streamEntered')
    }),
  ]
  const barriers = { beforePrepare, claimedPrepare, appended, streamEntered }
  return {
    ...barriers,
    dispose() {
      for (const barrier of Object.values(barriers)) barrier.release()
      for (const stop of stops) stop()
    },
  }
}
