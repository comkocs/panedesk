/** Session-backed admission and wake policy; cold reads never acquire write ownership. */
import type { Context } from '@panedesk/cordis'
import { SessionLogOffset, type SessionId } from '@panedesk/dsh-session'
import type { MessageSettings } from '@panedesk/dsh-message-delivery'
import type { ProjectionDefinition } from '@panedesk/dsh-session-projection'
import type {} from '@panedesk/dsh-session-persistence'
import { z } from 'zod'
import { MailboxUnavailableError } from './files.ts'

declare module '@panedesk/dsh-session-projection' {
  interface SessionProjectionStateMap { messageSettings: MessageSettings }
  interface SessionProjectionMap { messageSettings: MessageSettings }
}

const settingsSchema = z.object({ receiveMode: z.enum(['all', 'handoff-only', 'none']), wakeOnHandoff: z.boolean() })
const definition = {
  key: 'messageSettings', stateVersion: 1, stateSchema: settingsSchema,
  init: () => ({ receiveMode: 'all', wakeOnHandoff: true }),
  apply: (state, event) => event.type === 'message/settings' ? settingsSchema.parse(event.data) : state,
  wire: { viewSchema: settingsSchema, view: state => state },
} satisfies ProjectionDefinition<'messageSettings'>

/** Owns one projection registration, without an independently mutable settings cache. */
export class RecipientPolicy {
  constructor(private readonly ctx: Context) {
    ctx.inject(['sessionProjections'], inner => inner.sessionProjections.register(definition))
  }

  /** Read the live owner's exact policy before queue admission.
   * @param id - an already loaded Session.
   * @returns the complete projected settings, or throws when unavailable.
   */
  live(id: SessionId): MessageSettings {
    const session = this.ctx.sessions.get(id)
    const value = session && this.ctx.get('sessionProjections')?.stateOf(session, 'messageSettings')
    if (!value) throw new MailboxUnavailableError('Session receive policy is unavailable')
    return value
  }

  /** Read policy without opening an Agent or writing a projection checkpoint.
   * @param id - stored or live Session identity.
   * @returns current policy at the read cut; unreadable evidence fails closed.
   */
  async read(id: SessionId): Promise<MessageSettings> {
    if (this.ctx.sessions.get(id)) return this.live(id)
    const projections = this.ctx.get('sessionProjections')
    const persistence = this.ctx.get('sessionPersistence')
    if (!projections || !persistence) throw new MailboxUnavailableError('Session receive policy is unavailable')
    const handle = await persistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      const { snapshot } = projections.restore({}, events, SessionLogOffset(0), handle.header, handle.inheritedEventCount)
      const settings = snapshot.values.messageSettings
      if (!settings) throw new MailboxUnavailableError('Session receive policy projection is unavailable')
      return settings
    } finally { await handle.close() }
  }
}
