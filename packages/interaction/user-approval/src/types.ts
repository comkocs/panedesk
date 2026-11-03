/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains can
 * consume them without loading this package's Context augmentation.
 * @module @panedesk/dsh-user-approval/types
 */

import type { Branded } from '@panedesk/dsh-brand'
import type { Scoped } from '@panedesk/dsh-scope'
import type { Agent } from '@panedesk/dsh-agent/types'
import type { ToolCallId } from '@panedesk/dsh-llm/brand'

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * Closed approval outcomes: consent to the requested purpose, explicit rejection,
 * withdrawal, or unavailable answerer. Without a purpose, consent covers one action.
 * Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

declare module '@panedesk/dsh-session/types' {
  interface SessionEventMap {
    /**
     * An approval question was put to the answerer chain — log-only audit
     * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
     * it with the `approval/decided` that always follows; `toolName` is the
     * tool the question is about, `callId` the exact tool call when the asker
     * had one, `reason` the asker's human-readable explanation (e.g. a hook's
     * permission-decision reason).
     */
    'approval/asked': {
      id: ApprovalRequestId
      toolName: string
      callId?: ToolCallId
      reason?: string
      purpose?: ApprovalPurpose
    }
    /**
     * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
     * Exactly one per ask, appended when the outcome is known: a decision, a
     * cancellation, or the fail-closed `'unavailable'`.
     */
    'approval/decided': {
      id: ApprovalRequestId
      outcome: ApprovalOutcome
    }
  }
}

/** A question requesting durable workspace consent, distinct from one-operation approval. */
export interface WorkspaceWriteApproval {
  /** Identifies owner consent to persistent workspace access. */
  readonly type: 'workspace-write'
  /** Canonical directory whose product write ACL will be enabled. */
  readonly workspace: string
}

/** Consent to one exact executable-input identity and digest, not general filesystem access. */
export interface ProtectedInputApproval {
  readonly type: 'protected-input'
  readonly path: string
  readonly previous: string
  readonly current: string
}

/** Explicit owner decisions with purpose-specific consumers. */
export type ApprovalPurpose = WorkspaceWriteApproval | ProtectedInputApproval

/** Client-safe payload declared for the approval answerer waterfall. */
export interface ApprovalRequestEvent {
  /** Agent identity projected to the corresponding Client Context in transit. */
  readonly agent: Agent
  /** Tool whose operation requires a decision. */
  readonly toolName: string
  /** Exact tool call being decided, when available. */
  readonly callId?: ToolCallId
  /** Human-readable reason supplied by the asker. */
  readonly reason?: string
  /** Exact owner-approved purpose; absence retains ordinary one-operation approval. */
  readonly purpose?: ApprovalPurpose
  /** Localized presentation only; never persisted in approval audit events. */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /** Cancellation lifetime of the pending request. */
  readonly signal?: AbortSignal
}

declare module '@panedesk/cordis' {
  interface Events {
    /**
     * Ask composed answerers for one decision. Return an outcome to claim the
     * request or call `next()` to delegate. Scope-filtered dispatch
     * (`@panedesk/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param req - pending approval request.
     * @mode waterfall
     */
    'approval/request'(
      this: Scoped<Agent>,
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome>
  }
}
