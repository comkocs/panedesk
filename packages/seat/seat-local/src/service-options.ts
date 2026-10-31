/** Deployment options and trusted local capabilities are kept separate from wire requests. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import type { DefinitionCatalogs } from './schema.ts'
import type { WindowEvidence } from './status.ts'
import type { WaitRuntime } from './wait.ts'

/** Explicit node-local limits; none are inferred from a model or account name. */
export interface LocalSeatOptions {
  /** Private directory containing the node-local definition catalog. */
  directory: string
  /** Stable identity of the node that owns local seat operations. */
  nodeId: T.SeatNodeId
  /** Display name used when reporting the owning node. */
  nodeName: string
  /** Explicit aliases resolving imported node names to stable identities. */
  nodeAliases: Readonly<Record<string, T.SeatNodeId>>
  /** Deployment-supplied definition fields applied during import resolution. */
  defaults: Partial<T.SeatDefinition>
  /** Maximum UTF-8 byte length of an imported source. */
  maxSourceBytes: number
  /** Maximum number of retained import preview plans. */
  maxPlans: number
  /** Preview lifetime in milliseconds; omitted retains plans for 24 hours. */
  importPlanTtlMs?: number
  /** Maximum UTF-8 byte length of opening and wake text. */
  maxOpeningBytes: number
  /** Maximum number of explicitly named seats in one batch. */
  maxBatchSeats: number
  /** Maximum distinct seats, including seats named by source-directory rules. */
  maxSeats?: number
  /** Maximum entries per catalog, window or engine-fact page. */
  pageSize: number
  /** Maximum attempts for journal compare-and-set transactions. */
  transactionRetries: number
  /** Maximum retained directory-choice confirmations. */
  maxConfirmations: number
  /** Maximum accounting visibility wait for request-header evidence; omitted uses 1000 ms. */
  modelEvidenceWaitMs?: number
  /** Deployment-supplied suffix pinned to archived window titles. */
  closedSuffix: string
}

/** Runtime injection is queried at use time so optional providers can disappear safely. */
export interface LocalSeatRuntime {
  context: Context
  catalogs: DefinitionCatalogs
  evidence(sessionId: SessionId): Promise<WindowEvidence>
  cache(sessionId: SessionId): Promise<T.SeatCacheEvidence>
  renew(request: T.RenewSeatRequest): Promise<T.RenewSeatResult>
  rename(request: T.RenameSeatRequest): Promise<T.RenameSeatResult>
  title(sessionId: SessionId): Promise<string | null>
  send(request: { sessionId: SessionId; operationId: T.SeatOperationId; text: string; mode: 'steer' | 'queue' }):
  Promise<{ messageId: Extract<T.WakeSeatResult, { status: 'sent' | 'stored-budget-stopped' }>['messageId'] }>
  authorizeWait: WaitRuntime['authorize']
  snapshot: WaitRuntime['snapshot']
  subscribe: WaitRuntime['subscribe']
  /** Drain snapshot work after every observation subscription has been released. */
  drainObservations?(): Promise<void>
}
