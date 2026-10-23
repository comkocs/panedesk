/** Deployment options and trusted local capabilities are kept separate from wire requests. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import type { DefinitionCatalogs } from './schema.ts'
import type { WindowEvidence } from './status.ts'
import type { WaitRuntime } from './wait.ts'

/** Explicit node-local limits; none are inferred from a model or account name. */
export interface LocalSeatOptions {
  directory: string
  nodeId: T.SeatNodeId
  nodeName: string
  nodeAliases: Readonly<Record<string, T.SeatNodeId>>
  defaults: Partial<T.SeatDefinition>
  maxSourceBytes: number
  maxPlans: number
  maxOpeningBytes: number
  maxBatchSeats: number
  pageSize: number
  transactionRetries: number
  maxConfirmations: number
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
}
