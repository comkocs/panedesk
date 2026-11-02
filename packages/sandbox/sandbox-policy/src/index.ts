/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kit (the
 * `sandbox/mode` event, its fold, and its write path; the fold is the
 * `sandboxMode` session-projection unit registered here, while the event and
 * write path come from `./session-mode.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @panedesk/dsh-sandbox-policy
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@panedesk/cordis'
import { z as zod } from 'zod'
import z from '@panedesk/schemastery'
import type { Agent } from '@panedesk/dsh-agent'
import type { ToolCallId } from '@panedesk/dsh-llm'
import type {} from '@panedesk/dsh-user-approval'
import type { SandboxExecutionPolicy, SandboxMode } from '@panedesk/dsh-sandbox'
import type { Session } from '@panedesk/dsh-session'
import type {} from '@panedesk/dsh-session-projection'
import type {} from '@panedesk/dsh-system-prompt'

import { resolveDshHome } from '@panedesk/dsh-home-paths'
import { resolveEffectivePermissionMode } from './effective-mode.ts'
import type { EffectivePermissionMode } from './effective-mode.ts'
import { WorkspaceWriteAccess } from './workspace-access.ts'
import { resolveProtectedPaths } from './protected-paths.ts'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'
export { resolveEffectivePermissionMode } from './effective-mode.ts'
export { resolveProtectedPaths } from './protected-paths.ts'
export { WorkspaceWriteAccess } from './workspace-access.ts'
export type { WorkspaceWriteRecord } from './workspace-access.ts'

/** Preserve execution-world spelling; enforcing providers resolve filesystem identity on their host. */
function resolveWorkspaceRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error('sandbox-policy: workspace root must be an absolute execution-world path')
  return path
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write':
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

declare module '@panedesk/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. Without an explicit mode
 * or environment choice, Windows is read-only and Linux/macOS are workspace-writable. The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** Explicit file-sandbox mode; otherwise the environment or platform default applies. */
  mode?: SandboxMode
  /**
   * Absolute fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/** The sandbox-mode projection's state schema (state equals the public shape). */
const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

type SandboxModeState = zod.infer<typeof sandboxModeStateSchema>
declare module '@panedesk/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last logged sandbox-mode override, or null before one (deployment default applies at resolve time). */
    sandboxMode: SandboxModeState
  }
}

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
  })

  static inject = ['sessionProjections']

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** Whether configuration or the environment explicitly selected the deployment mode. */
  readonly defaultSource: EffectivePermissionMode['source']
  /** True only when Windows is using the implicit platform default. */
  readonly windowsDefault: boolean
  /** Product-home workspace authorizations, read afresh at each policy resolution. */
  readonly workspaceAccess: WorkspaceWriteAccess
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    const effective = resolveEffectivePermissionMode(config.mode)
    this.defaultMode = effective.mode
    this.defaultSource = effective.source
    this.windowsDefault = process.platform === 'win32' && effective.source === 'default'
    this.workspaceAccess = new WorkspaceWriteAccess(resolveDshHome(), () => resolveProtectedPaths(this.ctx))
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())

    ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session cwd is its workspace-write boundary; the
   * configured root is the fallback for agentless calls and sessions without a
   * cwd.
   * @param request - optional session and approved mode override.
   * @returns The per-call mode, absolute workspace root, and current protected host inputs when present.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    const workspaceRoot = resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)
    const explicit = request.mode ?? (session === undefined ? undefined : this.overrideOf(session))
    const mode = explicit ?? (this.windowsDefault && this.workspaceAccess.isAuthorized(workspaceRoot)
      ? 'workspace-write' : this.defaultMode)
    const protectedPaths = resolveProtectedPaths(this.ctx)
    return {
      mode,
      workspaceRoot,
      ...protectedPaths.length === 0 ? {} : { protectedPaths },
      ...session === undefined ? {} : { sessionId: session.id },
      ...this.windowsDefault && explicit === undefined && mode === 'workspace-write'
        ? { requiresWorkspaceAuthorization: true as const } : {},
    }
  }

  /**
   * Request persistent workspace consent before a potentially writing operation.
   * Explicit modes and non-Windows defaults never prompt. Missing, unattended,
   * rejected, withdrawn, or unavailable answerers leave the policy read-only.
   * @param request - Calling agent, tool identity, and cancellation lifetime.
   * @returns The freshly resolved policy after consent, or the unchanged standing policy.
   */
  async requestWrite(
    request: { agent?: Agent; toolName: string; callId?: ToolCallId; signal?: AbortSignal },
  ): Promise<SandboxExecutionPolicy> {
    const session = request.agent?.session
    const policy = this.resolve(session === undefined ? {} : { session })
    if (!this.windowsDefault || policy.mode !== 'read-only'
      || (session !== undefined && this.overrideOf(session) !== undefined)) return policy
    const approval = this.ctx.get('approval')
    if (request.agent === undefined || approval === undefined) return policy
    if ((approval.overrideOf(request.agent.session) ?? approval.config.policy) === 'never') return policy
    const workspace = this.workspaceAccess.canonical(policy.workspaceRoot)
    const outcome = await approval.request({
      ...request, agent: request.agent,
      purpose: { type: 'workspace-write', workspace },
      reason: `Allow sandboxed writes to ${workspace}? This adds a Windows directory write ACL. Revoke in Settings > General > Windows workspace write access.`,
      displayReason: {
        en: `Allow sandboxed writes to ${workspace}? This adds a Windows directory write ACL. Revoke in Settings > General > Windows workspace write access.`,
        zh: `允许向目录 ${workspace} 写入吗？这会添加 Windows 目录写入 ACL。可在设置 > 通用 > Windows 工作区写权限中撤销。`,
      },
    })
    if (outcome !== 'allowed-once' || request.signal?.aborted) {
      throw new Error(`Workspace write confirmation ${outcome}; access remains read-only. ${this.writeDenialHint('read-only')}`)
    }
    // An explicit policy change while the owner answers remains authoritative.
    if (session !== undefined && this.overrideOf(session) !== undefined) return this.resolve({ session })
    await this.workspaceAccess.authorize(workspace, 'first-confirmation', request.signal)
    request.signal?.throwIfAborted()
    const granted = this.resolve(session === undefined ? {} : { session })
    const sandbox = this.ctx.get('sandbox')
    if (sandbox?.supportsWorkspaceWriteAccess === true) {
      await sandbox.materializeWorkspaceWriteGrant?.(granted, request.signal)
    }
    return granted
  }

  /**
   * Explain owner-managed workspace access after a Windows default read-only denial.
   * @param mode - The settled operation's mode, not a fresh policy resolution.
   * @returns Settings guidance for implicit Windows read-only, otherwise undefined.
   */
  writeDenialHint(mode: SandboxMode): string | undefined {
    return this.windowsDefault && mode === 'read-only'
      ? 'Windows defaults to read-only. The owner can preauthorize the workspace in '
        + 'Settings > General > Windows workspace write access. Unattended tasks cannot grant this access. '
        + 'An explicit read-only session choice still applies after preauthorization.'
      : undefined
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'sandboxMode') ?? undefined
  }
}

export default SandboxPolicyService
