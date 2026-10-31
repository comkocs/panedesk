/** Node settings actions expose evidence without transport credentials or caller-owned authority. */
import type { SeatNodeId, CallbackResolveRequest } from '@panedesk/dsh-seat/types'
import type {} from '@panedesk/dsh-typert-protocol'

/** Confirmed action carries only the existing provider's immutable target and revision. */
export type NodeAction =
  | { kind: 'rebuild'; peerNodeId: SeatNodeId }
  | { kind: 'callback'; request: CallbackResolveRequest }
  | { kind: 'source'; action: 'resume' | 'abandon'; key: string; operationId: string; reason: string }

/** Provider evidence distinguishes refusal and uncertainty from a committed action. */
export interface NodeActionResult {
  status: 'ok' | 'rejected' | 'unavailable' | 'uncertain'
  code?: string
}

declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'nodes/unauthorized': Record<string, never>
    'nodes/disabled': Record<string, never>
    'nodes/unavailable': Record<string, never>
  }
}
