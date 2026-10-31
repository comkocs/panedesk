/** Structured failures owned by the read-only statistics capability. */
import type {} from '@panedesk/dsh-typert-protocol'

declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'stats/unauthorized': Record<string, never>
    'stats/disabled': Record<string, never>
    'stats/unavailable': Record<string, never>
  }
}
