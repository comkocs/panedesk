/** Owner-authorized seat facts shared by the Host projection and its Client resource. */
import type { OpenSeatResult, SeatBinding, SeatDefinition, SeatImportPlan, SeatImportRow, SeatName, SeatNodeStatus, SeatOperationId, SeatRejected, SeatWindowView } from '@panedesk/dsh-seat/types'

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
  /** Owner-only failures independent of dispatchable Session windows; absence clears prior diagnostics. */
  diagnostics?: {
    engine?: SeatNodeStatus['failure']
    openings: NonNullable<SeatNodeStatus['openingFailures']>
    callbacks?: SeatNodeStatus['callbackFailures']
  }
}

/** Manual opening accepts no caller-supplied authority or opening mode. */
export interface SeatUiOpenRequest {
  seat: SeatName
  operationId: SeatOperationId
  expectedSeatRevision: number
  /** Exact registered directory chosen by the owner; absent uses the profile startup directory. */
  startupDirectory?: string
}

/** Import fields consumed by the confirmation UI; other wire fields remain with the seat provider. */
export type SeatAddPlan = Pick<SeatImportPlan, 'planId' | 'baseRevision'> & {
  rows: readonly (Pick<SeatImportRow, 'row' | 'action'> & { diagnostics: readonly unknown[] })[]
}

/** Four user-entered values plus the selected configured model route. */
export interface SeatAddRequest {
  name: string
  directory: string
  provider: string
  model: string
  opening: string
  /** Advertised default effort; absent selects the provider's non-reasoning setting. */
  reasoningEffort?: string
}

/** Shared provider result, including a draft that must not be sent automatically. */
export type SeatUiOpenResult = OpenSeatResult
