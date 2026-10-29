/** Session-scoped notices for denied seat-memory writes; these are not Session log events. */
import type { SeatFailure } from '@panedesk/dsh-seat/types'
import type { SessionId } from '@panedesk/dsh-session/types'

declare module '@panedesk/cordis' {
  interface Events {
    /** Notify observers after a bound-seat memory write is denied.
     * @mode emit
     * @param sessionId - Tool executor's authenticated Session.
     * @param failure - Coded refusal and actionable alternative, without tool arguments.
     */
    'seat/memory-write-denied'(sessionId: SessionId, failure: SeatFailure): void
  }
}
