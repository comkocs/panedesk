/** Read-only inbox projections; message bodies and mailbox paths never cross the wire. */
import type { MessageQuarantineEvent, MessageStatus } from '@panedesk/dsh-message-delivery'
import type {} from '@panedesk/dsh-typert-protocol'

/** Existing message status enriched only with an authorized sender seat label. */
export interface InboxItem {
  status: MessageStatus
  senderSeat?: string
}
/** One complete or explicitly partial inbox observation for the requested Session. */
export interface InboxView {
  enabled: boolean
  items: readonly InboxItem[]
  quarantined: readonly MessageQuarantineEvent[]
  complete: boolean
}
declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'inbox/invalid-session': Record<string, never>
    'inbox/unauthorized': Record<string, never>
    'inbox/unavailable': Record<string, never>
  }
}
