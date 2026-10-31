/** Serializable local profile observations and confirmed catalog deletion requests. */
import type * as T from '@panedesk/dsh-seat/types'
import type { SessionId } from '@panedesk/dsh-session/types'

/** Complete observations used by the editor and deletion confirmation. */
export interface SeatProfileSnapshot {
  revision: number
  authority: T.SeatAuthority
  definitions: readonly T.SeatDefinition[]
  engineSequence: number
  windows: readonly Pick<T.SeatWindowView, 'seat' | 'sessionId' | 'title' | 'nodeId' | 'stateVersion'>[]
  pending: readonly Pick<T.PendingSeatItem, 'queueItemId' | 'seat' | 'reason' | 'stateVersion'>[]
  recentOpen: Readonly<Record<string, T.SeatTimestamp>>
}

/** Confirmation retains the observed impact; deletion never closes windows or cancels work. */
export interface RemoveSeatProfileRequest {
  seat: T.SeatName
  expectedRevision: number
  operationId: T.SeatOperationId
  confirmed: true
  windows: readonly SessionId[]
  pending: readonly T.QueueItemId[]
  engineSequence: number
  windowVersions: readonly Pick<T.SeatWindowView, 'sessionId' | 'stateVersion'>[]
  pendingVersions: readonly Pick<T.PendingSeatItem, 'queueItemId' | 'stateVersion'>[]
}
