/** Owner-authorized seat facts shared by the Host projection and its Client resource. */
import type { OpenSeatResult, SeatBinding, SeatDefinition, SeatName, SeatOperationId, SeatRejected, SeatWindowView } from '@panedesk/dsh-seat/types'

/** Read-only projection; missing providers are explicit rather than an empty ready catalog. */
export interface SeatOverview {
  available: boolean
  definitions: readonly SeatDefinition[]
  windows: readonly SeatWindowView[]
  complete: boolean
  /** Exact occurrence metadata when requested; absent when providers are unavailable. */
  binding?: SeatBinding | null | SeatRejected
  /** An isolated read failure permits retaining previously verified identity in the same open resource. */
  identityStatus?: 'failed'
}

/** Manual opening accepts no caller-supplied authority or opening mode. */
export interface SeatUiOpenRequest {
  seat: SeatName
  operationId: SeatOperationId
  expectedSeatRevision: number
  /** Exact registered directory chosen by the owner; absent uses the profile startup directory. */
  startupDirectory?: string
}

/** Shared provider result, including a draft that must not be sent automatically. */
export type SeatUiOpenResult = OpenSeatResult
