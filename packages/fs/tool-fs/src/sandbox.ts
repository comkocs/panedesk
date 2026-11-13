/**
 * The sandbox-escalation API shared by the `write` and `edit` tools: the
 * per-call policy resolution, the advertised escalation fields, and the denial-marker
 * mapping — all delegating the vocabulary and the fail-closed approval
 * sequence to `@panedesk/dsh-sandbox` (the same pieces `@panedesk/dsh-tool-bash`
 * uses), so bash and fs escalate identically. Built ONCE per plugin from
 * `ctx.fs.sandboxMode` (the capability fact — is a confining backend mounted?)
 * and shared by both mutating tools.
 *
 * @module @panedesk/dsh-tool-fs/sandbox
 */

import type { Context } from '@panedesk/cordis'
import type { ToolExecution } from '@panedesk/dsh-tools'
import type { SandboxExecutionPolicy, SandboxMode } from '@panedesk/dsh-sandbox'
import { ESCALATION_TARGETS, approveEscalation, escalationHintMarker, escalationPair, sandboxDenialMarker, sandboxPermissionsDescription } from '@panedesk/dsh-sandbox'
import type { SandboxPolicyService } from '@panedesk/dsh-sandbox-policy'
import { FsError } from '@panedesk/dsh-fs'

/** The two escalation arguments a mutating tool may carry (advertised only under a confining backend). */
export interface FsEscalationArgs {
  sandbox_permissions?: string
  justification?: string
}

/** The schema fields for the escalation arguments, spread into a tool's `parameters` when a confining backend is mounted. */
export interface EscalationSchemaFields {
  sandbox_permissions: { type: 'string'; enum: string[]; description: string }
  justification: { type: 'string'; description: string }
}

/**
 * The filesystem escalation API: advertisement gating, per-call policy
 * resolution, the one-approved wider retry, and denial-marker mapping. A pure
 * product of `ctx` at plugin apply time.
 */
export class FsSandboxController {
  /** The escalation targets this composition advertises (`[]` when no confining backend is mounted). */
  readonly escalationModes: readonly SandboxMode[]
  /** Shared per-session policy resolver, required by a confining backend. */
  private readonly policy: SandboxPolicyService | undefined
  private readonly escalatedPolicies = new WeakSet<SandboxExecutionPolicy>()

  constructor(private readonly ctx: Context) {
    const defaultMode = ctx.fs.sandboxMode
    this.escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS
    this.policy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
    if (defaultMode !== undefined && this.policy === undefined) {
      throw new Error('tool-fs: the mounted filesystem confines but ctx.sandboxPolicy is missing')
    }
  }

  /**
   * The escalation schema fields for a mutating tool's `parameters`. Call it
   * only under a confining backend (guard on {@link escalationModes}); the
   * enum pins the closed target vocabulary, the strict-wider check happens per
   * call at execution.
   * @returns the two escalation parameter specs.
   */
  schemaFields(): EscalationSchemaFields {
    return {
      sandbox_permissions: {
        type: 'string',
        enum: [...this.escalationModes],
        description: sandboxPermissionsDescription('operation'),
      },
      justification: {
        type: 'string',
        description: 'One sentence for the user explaining why this exact file operation needs the wider access. '
          + 'Required only together with a sandbox_permissions value wider than the current mode; omit both, or pass empty strings, to keep the current mode. '
          + 'Use the language of the user’s current request.',
      },
    }
  }

  /**
   * The policy to stamp onto this mutation: an approved escalation grant (a
   * strictly wider retry resolved through `ctx.approval` before anything
   * executes), else the Session's standing mode. Repeating the standing mode
   * requires no approval. Without escalation arguments, the implicit Windows
   * default requests persistent workspace consent before the first mutation.
   * The workspace root is the original Session directory, or the deployment
   * fallback when absent. Validates the escalation argument pairing first.
   * @param toolName - the mutating tool's name, for the approval audit trail.
   * @param args - the call's escalation arguments.
   * @param exec - the tool-execution context (agent, callId, signal).
   * @returns the policy to pass to the mutation, or undefined for an
   *   unsandboxed backend.
   */
  async resolvePolicy(toolName: string, args: FsEscalationArgs, exec: ToolExecution): Promise<SandboxExecutionPolicy | undefined> {
    const standingPolicy = this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} })
    const escalation = escalationPair(args.sandbox_permissions, args.justification, standingPolicy?.mode)
    if (escalation === undefined) {
      return standingPolicy
    }
    if (this.escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)')
    }
    const policy = standingPolicy as SandboxExecutionPolicy
    const approvedMode = await approveEscalation(
      { requestedMode: escalation.mode, justification: escalation.justification, effectiveMode: policy.mode, subject: 'operation' },
      {
        approver: this.ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName,
        signal: exec.signal,
      },
    )
    const resolved = { ...policy, mode: approvedMode }
    if (approvedMode !== policy.mode) this.escalatedPolicies.add(resolved)
    return resolved
  }

  /**
   * Refresh standing permission after asynchronous mutation preparation without asking again.
   * @param policy - Policy admitted before preparation.
   * @param exec - Calling agent whose standing permission may have changed.
   * @returns Current standing policy, or the explicitly approved policy for this call.
   */
  refreshPolicy(policy: SandboxExecutionPolicy | undefined, exec: ToolExecution): SandboxExecutionPolicy | undefined {
    if (policy !== undefined && this.escalatedPolicies.has(policy)) return policy
    return this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} })
  }

  /**
   * Map a thrown provider error for the model: a `FS_SANDBOX_DENIED` becomes a
   * `FsError` whose text is the shared `[sandbox: …]` denial marker plus the
   * same-turn escalation hint, so a policy denial reads identically to bash's
   * WHILE keeping the structured `FS_SANDBOX_DENIED` code — `ToolRuntime`
   * populates `result.error` only for `HarnessError` instances, so a plain
   * `Error` would strip the code retry/observers key off. Any other error
   * passes through unchanged. Windows implicit-default read-only denials name
   * owner preauthorization instead of suggesting an unattended approval retry.
   * The result text is retained by the caller's ordinary tool/result event.
   * @param error - the error thrown by the mutation.
   * @param policy - the policy stamped onto the call (names the mode in the marker).
   * @returns the error to throw — the marker `FsError` for a sandbox denial, else the original.
   */
  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
    // A FS_SANDBOX_DENIED only arises under a confining backend, whose tool
    // path always resolves a policy before mutation.
    const mode = (policy as SandboxExecutionPolicy).mode
    return new FsError(`${sandboxDenialMarker(mode)}\n${escalationHintMarker('operation')}`, 'FS_SANDBOX_DENIED', { cause: error })
  }
}
