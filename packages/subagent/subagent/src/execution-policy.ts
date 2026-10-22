/** In-process definition admission and monotonic execution guards. */
import type { Context } from '@panedesk/cordis'
import type { Agent, AgentOptions } from '@panedesk/dsh-agent'
import type { PresetExecutionPolicy } from '@panedesk/dsh-agent-preset-registry'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import type { ActivationObserver } from './lifecycle.ts'
import { SubagentError } from './error.ts'

/** Resolve the retained parent generation or an independently selected definition.
 * @param parent Delegating agent with its retained generation.
 * @param selected Explicit independent preset, if requested.
 * @returns The immutable execution policy, absent for legacy presets.
 */
export async function resolveExecutionPolicy(parent: Agent, selected?: string): Promise<PresetExecutionPolicy | undefined> {
  const presets = parent.ctx.get('agentPresets')
  if (selected === undefined) return presets?.composedPolicy(parent.ctx)?.executionPolicy
  if (presets === undefined) throw new SubagentError('selecting a child agent preset requires the agent-presets service', 'PRESET_UNAVAILABLE')
  return (await presets.resolve(selected)).executionPolicy
}

/** Reject explicit conflicts and use definition routing ahead of inherited defaults.
 * @param requested Explicit dispatch options only, not inherited defaults.
 * @param policy Immutable definition policy.
 * @returns Definition-owned route with compatible caller options retained.
 */
export function definitionOptions(requested: AgentOptions | undefined, policy?: PresetExecutionPolicy): AgentOptions | undefined {
  if (policy === undefined) return requested
  for (const field of ['provider', 'model', 'reasoningEffort'] as const) {
    if (requested?.[field] !== undefined && requested[field] !== policy[field]) {
      throw new SubagentError(`Execution policy denies ${field} "${requested[field]}"; definition requires "${policy[field]}"`, 'POLICY_DENIED')
    }
  }
  return { ...requested, provider: policy.provider, model: policy.model, reasoningEffort: ReasoningEffortId(policy.reasoningEffort) }
}

/** Install description filtering for spawn and final guards for both local modes.
 * @param ctx Child scope after its preset composition is mounted.
 * @param child Exact child whose model and tool dispatches are guarded.
 * @param inheritedContext Whether fork retains the parent's tool descriptions.
 * @param observer Awaitable accounting owned by this activation.
 * @param captured Policy captured at admission, retained across asynchronous preparation.
 */
export function installExecutionPolicy(
  ctx: Context, child: Agent, inheritedContext: boolean, observer: ActivationObserver, captured?: PresetExecutionPolicy,
): void {
  const policy = captured ?? ctx.get('agentPresets')?.composedPolicy(ctx)?.executionPolicy
  if (policy === undefined) return
  definitionOptions(child.options, policy)
  const allowed = new Set(policy.allowedTools)
  if (!inheritedContext) ctx.tools.restrict({ allow: policy.allowedTools })
  const deny = (operation: 'model' | 'effort' | 'tool', requested: string): string => {
    const reason = `Execution policy ${policy.rulesId}@${policy.version} denies ${operation} "${requested}"`
    observer.deny?.(operation, requested, policy, reason)
    return reason
  }
  const routeDenial = (route: { provider?: string; model?: string; reasoningEffort?: string }): string | undefined => {
    if (route.provider !== policy.provider || route.model !== policy.model) return deny('model', `${route.provider ?? 'unknown'}/${route.model ?? 'unknown'}`)
    if (route.reasoningEffort !== policy.reasoningEffort) return deny('effort', route.reasoningEffort ?? 'unspecified')
    return undefined
  }
  ctx.tools.guard((exec) => {
    const route = child.session.requestHeader()?.config ?? child.options
    const reason = routeDenial(route)
    if (reason !== undefined) return reason
    // The reserved transport is not an end capability; nested calls encounter this same guard.
    return exec.name === 'run_code' || allowed.has(exec.name) ? undefined : deny('tool', exec.name)
  })
  ctx.on('agent/request', async (_payload, next) => {
    const route = await next()
    const reason = routeDenial(route)
    if (reason !== undefined) throw new SubagentError(reason, 'POLICY_DENIED')
    return route
  })
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === child.id) {
      const reason = routeDenial(options)
      if (reason !== undefined) throw new SubagentError(reason, 'POLICY_DENIED')
    }
    return next()
  })
}
