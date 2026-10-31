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
  items: readonly import('@panedesk/dsh-seat').PendingSeatObservation[]
  complete: boolean
  /** Committed retention terminal evidence; absent from older providers. */
  rejected?: NonNullable<import('@panedesk/dsh-seat').ListPendingSeatsResult['rejected']>
  /** Stable resource-owned announcements, not recomputed when the panel opens. */
  alerts?: readonly { id: string; seat: import('@panedesk/dsh-seat').SeatName; phase: 'expiring' | 'expired' }[]
}
