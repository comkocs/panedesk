/** Serializable local profile observations and confirmed catalog deletion requests. */
import type * as T from '@panedesk/dsh-seat/types'
import type { SessionId } from '@panedesk/dsh-session/types'

/** One observed window. A cold window keeps its identity and leaves its state version unknown. */
export interface SeatProfileWindow extends Pick<T.SeatWindowView, 'seat' | 'sessionId' | 'title' | 'nodeId'> {
  /** Null only when runtime evidence is incomplete; zero is a real version, never a stand-in. */
  stateVersion: number | null
  /** False when this window has no running owner, such as after a host restart. */
  stateKnown: boolean
}

/** Complete observations used by the editor and deletion confirmation. */
export interface SeatProfileSnapshot {
  revision: number
  authority: T.SeatAuthority
  definitions: readonly T.SeatDefinition[]
  engineSequence: number
  windows: readonly SeatProfileWindow[]
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
  windowVersions: readonly { sessionId: SessionId; stateVersion: number | null }[]
  pendingVersions: readonly Pick<T.PendingSeatItem, 'queueItemId' | 'stateVersion'>[]
}
