/**
 * Client-safe wire types for the read-only subagent tree and monitoring view.
 *
 * @module @panedesk/dsh-client-ui-subagent-tree/types
 */

import type {} from '@panedesk/dsh-typert-protocol'
import type { SessionId } from '@panedesk/dsh-session/types'

declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The invocation principal is not an authenticated owner. */
    'subagentTree/unauthorized': Record<string, never>
    /** The deployment disabled the subagent tree read. */
    'subagentTree/disabled': Record<string, never>
    /** The read was cancelled or its owning service stopped mid-request. */
    'subagentTree/unavailable': Record<string, never>
  }
}

/** Target of one `subagentTree.read` call: the session whose subagent tree is requested. */
export interface SubagentTreeRequest {
  /** Session shown on screen; its descendants form the tree. */
  readonly sessionId: SessionId
}

/**
 * Five observed token columns for one session's model calls. `null` keeps an
 * unobserved column unknown; it never stands for a measured zero.
 */
export interface SubagentTokenColumns {
  /** Uncached input tokens summed over the session's calls. */
  readonly inputTokens: number | null
  /** Cache-read (hit) tokens summed over the session's calls. */
  readonly cacheReadTokens: number | null
  /** Short-tier cache writes; `null` when a write total is untiered or missing. */
  readonly cacheWriteShortTokens: number | null
  /** Long-tier cache writes; `null` when no long tier was observed. */
  readonly cacheWriteLongTokens: number | null
  /** Output tokens summed over the session's calls. */
  readonly outputTokens: number | null
  /** Total cache writes when tiering is not provable; `null` otherwise. */
  readonly cacheWriteTokens: number | null
}

/** Coarse monitoring state of one node derived from ledger lifecycle and wait facts. */
export type SubagentNodeStatus = 'running' | 'waiting' | 'finished'

/** Process-liveness observation for one node; it never overrides lifecycle facts. */
export type SubagentLiveness = 'confirmed' | 'unknown' | 'dead'

/** Terminal cause of a finished run residency, verbatim from the ledger. */
export type SubagentEndReason = 'completed' | 'timeout' | 'killed' | 'error' | 'cancelled'

/** Most recent tool invocation recorded in the session transcript. */
export interface SubagentLastToolCall {
  /** Tool name exactly as the transcript's tool call event recorded it. */
  readonly name: string
  /** Unix epoch milliseconds of that event. */
  readonly time: number
}

/** Why a node's model column is absent; the ledger is never used as a fallback. */
export type SubagentModelSource = 'transcript' | 'unavailable' | 'unreadable'

/** One tree node: parent-child identity plus the read-only monitoring facts. */
export interface SubagentTreeNode {
  /** The session this node stands for. */
  readonly sessionId: SessionId
  /** Direct parent session; `null` only for the requested root. */
  readonly parentSessionId: SessionId | null
  /** Children in first-observed ledger order. */
  readonly children: readonly SubagentTreeNode[]
  /** Monitoring state from lifecycle and wait facts. */
  readonly status: SubagentNodeStatus
  /** Latest process-liveness observation carried by the ledger. */
  readonly liveness: SubagentLiveness
  /** Terminal cause; present only while `status` is `finished`. */
  readonly endReason?: SubagentEndReason | undefined
  /** Model id from the transcript's assistant messages; `null` stays unknown. */
  readonly model: string | null
  /** Which transcript read path produced — or failed to produce — `model`. */
  readonly modelSource: SubagentModelSource
  /** Five token columns over the session's calls. */
  readonly tokens: SubagentTokenColumns
  /** Coverage of the usage evidence behind `tokens`. */
  readonly usageState: 'missing' | 'partial' | 'complete'
  /** Cache-read share of billed input; `null` when the denominator is unobserved. */
  readonly cacheHitRate: number | null
  /** Latest residency duration in milliseconds; `null` without a run start. */
  readonly elapsedMs: number | null
  /** Run residencies the ledger recorded for this session. */
  readonly runs: number
  /** Model calls attributed to this session. */
  readonly calls: number
  /** Most recent transcript tool invocation; `null` when none is recorded. */
  readonly lastToolCall: SubagentLastToolCall | null
  /** Seat identity of the latest attributed row; `null` when no row carries one. */
  readonly seat: string | null
  /** Linked task id of the latest attributed row; `null` when absent. */
  readonly taskId: string | null
}

/** Whole-tree read result over one ledger snapshot plus per-node transcript facts. */
export interface SubagentTreeView {
  /** Ledger observation instant for the values in this view. */
  readonly asOf: number
  /** Whether the ledger scan covered every node's journal. */
  readonly complete: boolean
  /** Root node for the requested session; always present, with children possibly empty. */
  readonly root: SubagentTreeNode
  /** Client refresh cadence the deployment configured, in milliseconds. */
  readonly refreshIntervalMs: number
}
