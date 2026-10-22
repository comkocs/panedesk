/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @panedesk/dsh-agent/types
 */

import type { UserMessage } from '@panedesk/dsh-llm/types'
import type { MessageId } from '@panedesk/dsh-llm/brand'
import type { Branded } from '@panedesk/dsh-brand'
// Type-only: the Workspace registry's archive-admission family map this registry merges `turn` into.
import type {} from '@panedesk/dsh-workspace/types'
import type { OptionalSessionSeq, SessionId, SessionSeq } from '@panedesk/dsh-session/types'
import type { TypertContext, TypertLookup } from '@panedesk/dsh-typert-protocol'
import type { JsonValue } from '@panedesk/dsh-util-values'

/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
}

declare module '@panedesk/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** The session's own Agent is inside a turn, including one waiting for an approval or an answer. */
    turn: true
  }
}

declare module '@panedesk/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>
  }

  interface TypertContextMap {
    /** Agent Context identity shared by Host and Client adapters. */
    agent: TypertContext<SessionId>
  }
}

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

/** Effective scheduling order: immediate before steer before queue; equal priorities retain enqueue order. */
export type InputPriority = 'immediate' | 'steer' | 'queue'

/** One reservation, retained until rollback or the first actual request dispatch. */
export type InputClaimId = Branded<'InputClaimId'>

/** Durable scheduling facts; legacy entries without them retain their original inbox semantics. */
export interface InputScheduling {
  readonly priority: InputPriority
  /** Passive work joins a natural turn but never drives a new turn by itself. */
  readonly passive: boolean
  /** Host-assigned order, independent of wall time and message identity. */
  readonly enqueueSequence: number
  /** Earliest eligible turn; queue notices cannot enter the current turn mid-step. */
  readonly earliestTurn: number
}

/** Required-on-read input lifecycle facts; appended input stays claimed after a synchronous pre-dispatch failure. */
export type InputTransition =
  | {
    /** Commit before the matching inbox splice; older readers refuse this required event before replaying scheduling-aware input. */
    readonly phase: 'scheduled'
    readonly messageIds: readonly MessageId[]
    readonly scheduling: readonly InputScheduling[]
  }
  | ({
    readonly claimId: InputClaimId
    readonly messageIds: readonly MessageId[]
    readonly turn: number
    readonly step: number
  } & (
    | { readonly phase: 'claimed' }
    | { readonly phase: 'appended'; readonly userEventSeqs: readonly SessionSeq[] }
    | { readonly phase: 'rolled-back'; readonly scheduling: readonly InputScheduling[] }
    | { readonly phase: 'dispatched'; readonly requestId: Branded<'InputRequestId'> }
  ))

/** Complete pending Inbox value reconstructed from durable splices. */
export interface InboxState {
  readonly 'next-turn': readonly UserMessage[]
  readonly 'next-step': readonly UserMessage[]
}

/**
 * Wire-JSON pending Inbox value. Each message round-trips the session log
 * losslessly, but the fold state's full `UserMessage` type cannot cross a
 * typert Remote boundary (its source union carries an `unknown` replay
 * field), so the typed projection table keeps this JSON-safe form.
 */
export interface InboxWireState {
  readonly 'next-turn': readonly JsonValue[]
  readonly 'next-step': readonly JsonValue[]
}

declare module '@panedesk/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxState
  }
  interface SessionProjectionMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxWireState
  }
}

/**
 * Turn and step boundaries folded from one agent session log.
 *
 * Reader contract: the key is registered by `dsh-agent-loop` and absent
 * otherwise. Without agent-loop no turn events exist, so readers treat an
 * absent key as "no open turn / no boundaries" — capability absence, not a
 * corrupt state. A reader whose behavior has no safe fallback for that
 * absence (the step-open decision, for example) may fail loud instead.
 */
export interface TurnBoundaryProjection {
  /** Seq of the open turn's `turn/start`, or null between turns. */
  readonly openTurnStartSeq: OptionalSessionSeq
  /** Seq of the latest `step/start` event, or null before the first step. */
  readonly lastStepStartSeq: OptionalSessionSeq
  /** The latest step boundary (`step/start` or `step/end`) and its seq, or null before the first step boundary. */
  readonly lastStepBoundary: { readonly kind: 'start' | 'end'; readonly seq: SessionSeq } | null
  /** Turn number of the latest `turn/start`; 0 before the first turn. */
  readonly lastTurn: number
}

declare module '@panedesk/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * The session-projection registry applies the committed event before
     * `Session.append()` returns; Inbox live notifications follow that commit.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
      /** Parallel to inserted; absence retains legacy scheduling. A required scheduled transition must precede this splice. */
      scheduling?: readonly InputScheduling[]
    }
    /**
     * Required input reservation fact; rollback is legal only before append, dispatch commits first injection.
     * @param data - claim identity, input identities, boundary, and committed phase.
     */
    'agent/input/transition': InputTransition
  }
}
