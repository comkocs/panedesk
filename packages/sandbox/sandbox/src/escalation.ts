/**
 * The escalation vocabulary and choreography shared by every sandbox-enforcing
 * tool family (`@panedesk/dsh-tool-bash`, `@panedesk/dsh-tool-fs`): the
 * strictly-wider ladder, the argument-pairing validation, the model-facing
 * denial/hint markers, and {@link approveEscalation} — the ordered fail-closed
 * sequence that resolves a `sandbox_permissions` request through a
 * user-approval channel BEFORE anything executes. One home keeps the two
 * families' approval ordering and verbatim error texts from drifting apart.
 *
 * The channel is a minimal STRUCTURAL function shape ({@link EscalationAsk}),
 * not the approval service type: the tool layer — which owns the agent, the
 * call id, and the tool name — closes over `ctx.approval.request(...)` and
 * hands the closure down, so this package never depends on the approval or
 * agent packages.
 *
 * @module dsh-sandbox/escalation
 */

import { assertNever } from '@panedesk/dsh-util-values'
import type { SandboxMode } from './index.ts'

/**
 * The strictly-wider table: what a call whose effective mode is the key may
 * escalate TO. Checked at EXECUTION, never baked into a tool schema — the
 * schema's enum is {@link ESCALATION_TARGETS}, because schemas are
 * registry-global while the effective mode is per-call truth.
 */
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * The closed escalation-target vocabulary — every mode a call could ever
 * escalate TO (`read-only` is the floor; nothing escalates to it). Advertised
 * whenever the mounted capability confines: cutting the enum down to the modes
 * wider than the composition's DEFAULT would strand a session whose effective
 * mode sits below it (a `danger-full-access` default would advertise nothing
 * while a narrower-switched session stays confined with no lever).
 */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access']

/**
 * Treat a blank optional string as omitted. Models often send `""` for a field
 * the schema lists but does not require; that is the same as leaving it out.
 * @param value - the raw argument, if given.
 * @returns the trimmed value, or `undefined` when it was omitted or blank.
 */
export function omittedIfBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Rank on the closed sandbox ladder; unknown names sit below every known mode. */
const MODE_RANK: Readonly<Record<string, number>> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

/**
 * Whether a requested mode is the current one or narrower, so the call can
 * keep running under the current mode without an approval sentence.
 * @param requested - trimmed requested mode.
 * @param effective - the call's current mode.
 * @returns true when the request does not widen access.
 */
export function modeWithinCurrent(requested: string, effective: SandboxMode): boolean {
  const requestedRank = MODE_RANK[requested]
  const effectiveRank = MODE_RANK[effective]
  return requestedRank !== undefined && effectiveRank !== undefined && requestedRank <= effectiveRank
}

/**
 * Validate the escalation argument pairing a tool schema cannot express.
 * Both fields blank means no escalation. A mode that does not widen access
 * also needs no sentence. A widening mode without a sentence, or a sentence
 * without a mode, says which field to omit or fill.
 * @param sandboxPermissions - the raw `sandbox_permissions` argument, if given.
 * @param justification - the raw `justification` argument, if given.
 * @param effectiveMode - the call's current mode, when the caller knows it.
 * @returns the paired mode and sentence, or `undefined` when nothing widens.
 */
export function escalationPair(
  sandboxPermissions: string | undefined,
  justification: string | undefined,
  effectiveMode?: SandboxMode,
): { mode: string; justification: string } | undefined {
  const mode = omittedIfBlank(sandboxPermissions)
  const reason = omittedIfBlank(justification)
  if (mode === undefined && reason === undefined) return undefined
  if (mode !== undefined && reason === undefined && effectiveMode !== undefined && modeWithinCurrent(mode, effectiveMode)) return undefined
  if (mode !== undefined && reason === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification — pass one sentence with the mode, or omit both fields to keep the current mode')
  }
  if (reason !== undefined && mode === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions — pass the wider mode too, or omit both fields to keep the current mode')
  }
  return { mode: mode as string, justification: reason as string }
}

/**
 * Reject a half-filled escalation pair. Both blank is not an escalation.
 * Callers that need the trimmed pair use {@link escalationPair}.
 * @param sandboxPermissions - the raw `sandbox_permissions` argument, if given.
 * @param justification - the raw `justification` argument, if given.
 */
export function validateEscalationArgs(sandboxPermissions: string | undefined, justification: string | undefined, effectiveMode?: SandboxMode): void {
  escalationPair(sandboxPermissions, justification, effectiveMode)
}

/**
 * The model-facing denial marker — the one vocabulary both enforcing families
 * teach and report, so the model recognizes a policy denial identically
 * whether the kernel refused a bash file effect or the filesystem provider's
 * fence refused a mutation.
 * @param mode - the mode the denied call ran under.
 * @returns the marker line, exactly as the model sees it.
 */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/**
 * The same-turn escalation hint that rides a denial when the composition
 * advertises the escalation fields — the nudge lives at the decision point so
 * the sanctioned retry does not depend on the model recalling the tool
 * description.
 * @param subject - the family's noun for the denied action (`command` for
 *   bash, `operation` for a filesystem mutation).
 * @returns the hint line, exactly as the model sees it.
 */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/**
 * The model-facing `sandbox_permissions` parameter description, which carries
 * the escalation rules for every enforcing family.
 * @param subject - the family's noun for the denied action (`command` for
 *   bash, `operation` for a filesystem mutation).
 * @returns the parameter description, exactly as the model sees it.
 */
export function sandboxPermissionsDescription(subject: string): string {
  return `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval. `
    + 'Omit this field, or pass an empty string, to keep the current mode. A mode that is the same as or narrower than the current mode runs under the current mode without approval.'
}

/**
 * The closed outcome vocabulary of one escalation ask — structurally identical
 * to the approval seam's `ApprovalOutcome` so an `ApprovalService.request`
 * return is assignable without this package importing it.
 */
export type EscalationOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The minimal approval-request shape {@link approveEscalation} needs —
 * structurally the approval seam's `ApprovalService`, generic over the agent
 * type `A` and call-id type `C` so this package resolves escalations through
 * `ctx.approval` without importing the approval or agent packages (the tool
 * layer infers `A`/`C` as its own `Agent`/`ToolCallId`).
 */
export interface EscalationApprover<A = object, C = string> {
  /**
   * Ask the human to approve one action, resolving to a closed outcome.
   * @param req - the audit request with optional localized displayReason and presentation lifetime signal.
   * @returns the human's decision as a closed {@link EscalationOutcome}.
   */
  request(req: {
    agent: A
    toolName: string
    callId: C
    reason: string
    displayReason?: { readonly en: string; readonly [locale: string]: string }
    signal?: AbortSignal
  }): Promise<EscalationOutcome>
}

/**
 * The approval ingredients an escalating tool hands {@link approveEscalation}:
 * the approval requester (`ctx.approval`, or `undefined` when none is
 * composed), the calling agent (or `undefined` for an agent-less execution),
 * and the call's identity. The tool layer holds all of these; this package
 * only judges them.
 */
export interface EscalationApproval<A = object, C = string> {
  /** The approval requester (`ctx.approval`), or `undefined` when none is composed. */
  approver: EscalationApprover<A, C> | undefined
  /** The calling agent, or `undefined` for an agent-less execution (fails closed). */
  agent: A | undefined
  /** The tool-call id the approval prompt attaches to. */
  callId: C
  /** The tool name recorded on the approval request. */
  toolName: string
  /** The tool-execution abort signal the approval request rides, when present. */
  signal?: AbortSignal
}

/** One escalation request, as {@link approveEscalation} judges it. */
export interface EscalationRequest {
  /** The requested target mode (schema-pinned to {@link ESCALATION_TARGETS} when advertised). */
  requestedMode: string
  /** The model's one-sentence reason, shown verbatim to the user inside the audit reason. */
  justification: string
  /** The call's effective mode (session override ?? composition default); repeating it needs no approval. */
  effectiveMode: SandboxMode
  /** The family's noun for the escalated action in user-facing texts (`command` for bash, `operation` for fs). */
  subject: string
}

/**
 * Resolve a sandbox permission request before execution. Repeating the call's
 * effective mode, or requesting a narrower one, returns the current mode
 * without approval. A strictly wider mode requires approval and applies only
 * to this call. Unsupported targets, missing approval services or agents for
 * widening, and non-grant outcomes throw before execution.
 * @param request - the escalation to judge (see {@link EscalationRequest}).
 * @param approval - the approval ingredients the tool holds (see {@link EscalationApproval}).
 * @returns the granted mode, consumed by the one call that asked.
 */
export async function approveEscalation<A, C>(request: EscalationRequest, approval: EscalationApproval<A, C>): Promise<SandboxMode> {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  // Same or narrower than the call's effective mode needs nothing: run as-is.
  // Strict widening stays an EXECUTION check — deliberately not a schema
  // constraint (the enum is the closed target vocabulary; the effective mode
  // is per-call truth). A name outside that ladder still fails here.
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
    if (mode === effectiveMode || (WIDER_MODES[mode] ?? []).includes(effectiveMode)) return effectiveMode
    throw new Error(`sandbox mode "${mode}" is not a known mode; omit sandbox_permissions and justification to keep the current "${effectiveMode}" mode, or pass one of: ${(WIDER_MODES[effectiveMode] ?? []).join(', ') || '(none — already unrestricted)'}`)
  }
  if (approval.approver === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
  }
  if (approval.agent === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
  }
  // Self-contained for the audit trail: approval/asked stores this reason,
  // and the target mode is part of the grant's identity.
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    displayReason: {
      en: `Allow this operation with ${mode} permissions: ${justification}`,
      zh: `允许本次操作使用 ${mode} 权限：${justification}`,
    },
    ...approval.signal ? { signal: approval.signal } : {},
  })
  switch (outcome) {
    // The schema enum already pinned `mode` to the closed target vocabulary;
    // the check above proved it is strictly wider.
    case 'allowed-once': return mode as SandboxMode
    case 'rejected': throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`)
    case 'cancelled': throw new Error(`approval for escalating to "${mode}" was cancelled`)
    case 'unavailable': throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
    default: return assertNever(outcome, 'EscalationOutcome')
  }
}
