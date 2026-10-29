import type {} from '@panedesk/dsh-typert-protocol'

declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'seat-approvals/unauthorized': Record<string, never>
    'seat-approvals/unavailable': Record<string, never>
  }
}

/** Safe pending queue observation, without frozen instructions or source bodies. */
export interface ApprovalQueueView {
  enabled: boolean
  items: readonly import('@panedesk/dsh-seat').PendingSeatItem[]
  complete: boolean
}
