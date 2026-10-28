/** Opt-in model tools for direct messages to open seats on this node. */
import type { Context } from '@panedesk/cordis'
import { registerSeatMessageTools } from './tools.ts'

/** Loader plugin identity. */
export const name = 'tool-seat-messages'
/** Missing providers contribute no tools. */
export const inject: string[] = []

/** Install local direct-message tools while their providers remain available.
 * @param ctx - lifecycle owner of the tool registrations.
 */
export function apply(ctx: Context): void {
  ctx.inject(['tools', 'agents', 'messageDelivery', 'seatLocalRead'], registerSeatMessageTools)
}
