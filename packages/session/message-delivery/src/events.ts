/** Durable receive policy and runtime-only message receipt notifications. */
import type { MessageSettings, MessageStateEvent } from './types.ts'
import type {} from '@panedesk/dsh-session/types'

declare module '@panedesk/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete receive-policy replacement, required on read; absence retains all/true defaults.
     * @param data - receive admission and handoff wake settings.
     */
    'message/settings': MessageSettings
  }
}

declare module '@panedesk/cordis' {
  interface Events {
    /**
     * Committed receipt notification; it neither drives a turn nor substitutes for durable replay.
     * @mode emit
     * @param event - durable cursor and runtime-observed message state.
     */
    'message/state'(event: MessageStateEvent): void
  }
}
