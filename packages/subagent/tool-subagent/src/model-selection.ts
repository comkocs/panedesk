/** Child LLM route selection for the subagent tool. */

import { ReasoningEffortId } from '@panedesk/dsh-llm'
import type { LlmRuntime, LlmModelInfo, LlmResolvedModelInfo } from '@panedesk/dsh-llm'
import type { AgentOptions } from '@panedesk/dsh-agent'
import z from '@panedesk/schemastery'

/**
 * Read configured models in the provider order shown by Models settings.
 * @param llm - Live LLM runtime.
 * @returns Advertised models with their provider ids.
 */
export async function configuredModels(llm: LlmRuntime): Promise<LlmModelInfo[]> {
  const registered = llm.listProviders()
  const active = new Set(registered.map(provider => provider.id))
  const directory = llm.listConfigurableProviders()
  const declared = new Set(directory.map(entry => entry.provider))
  const providers = [
    ...directory.filter(entry => active.has(entry.provider)),
    ...registered.filter(provider => !declared.has(provider.id)).map(provider => ({ provider: provider.id, declared: false })),
  ]
  const rank = (entry: (typeof providers)[number]): number =>
    entry.provider === 'deepseek-official' ? 2 : entry.declared === true ? 0 : 1
  return (await Promise.all(providers.toSorted((left, right) => rank(left) - rank(right))
    .map(entry => llm.listModels(entry.provider)))).flat()
}

/**
 * Resolve an exact model name, rejecting missing or ambiguous routes.
 * @param models - Live configured catalog.
 * @param model - Exact requested model id.
 * @param provider - Optional provider that disambiguates the model.
 * @returns The unique configured provider/model pair.
 */
export function resolveModelRoute(models: readonly LlmModelInfo[], model: string, provider?: string): AllowedModelRoute {
  const matches = models.filter(candidate => candidate.id === model && (provider === undefined || candidate.provider === provider))
  if (matches.length === 1) return { provider: matches[0]!.provider, model }
  const routes = (rows: readonly LlmModelInfo[]): string => rows.map(row => `${row.provider}/${row.id}`).join(', ') || '(none)'
  if (matches.length > 1) throw new Error(`Model "${model}" matches multiple providers; specify provider: ${routes(matches)}`)
  throw new Error(`Model "${provider === undefined ? '' : `${provider}/`}${model}" is not configured; available models: ${routes(models)}`)
}

/** One exact child LLM route authorized by a user setting. */
export interface AllowedModelRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
}

/**
 * Escalation rank of the reasoning-effort ids adapters declare, used only to
 * pick the nearest supported effort when no provider serves the requested one.
 * Efforts outside this set keep their relative order from the route's own
 * escalation-sorted list and never outrank a known effort.
 */
const EFFORT_RANK: Readonly<Record<string, number>> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/**
 * One bare-name provider candidate.
 * `efforts` is absent when the route declares no selectable efforts and therefore
 * does not participate in effort filtering; `undefined` means its metadata could
 * not be read. `skip` is set only when declared efforts omit the requested one.
 */
interface EffortCandidate {
  readonly route: AllowedModelRoute
  /** Escalation-sorted selectable efforts; absent when the route declares none. */
  readonly efforts?: readonly ReasoningEffortId[]
  readonly skip: string | undefined
}

/** A preset model name resolved to one provider route and its effective effort. */
export interface PresetModelRoute {
  readonly route: AllowedModelRoute
  /** Effective effort for the resolved route, including a lowered one. */
  readonly effort?: ReasoningEffortId
  /** The effort actually served when no provider offers the requested level. */
  readonly loweredTo?: ReasoningEffortId
  /**
   * Set when the winning route declares no selectable efforts, so the requested
   * effort is not sent. Cards show this as "effort not applicable".
   */
  readonly effortNotApplicable?: true
}

/**
 * The effort closest to the requested level on an escalation-sorted list.
 * Ties resolve downward: a request between two supported efforts picks the
 * lower one, and an unknown requested id keeps the route's highest effort.
 * @param efforts - selectable efforts from least to greatest.
 * @param requested - effort the preset or caller asked for.
 * @returns the list entry nearest the request.
 */
function nearestEffort(efforts: readonly ReasoningEffortId[], requested: ReasoningEffortId): ReasoningEffortId {
  const requestedRank = EFFORT_RANK[requested]
  let best = efforts[0]!
  let bestDistance = requestedRank === undefined
    ? Number.POSITIVE_INFINITY
    : Math.abs((EFFORT_RANK[best] ?? Number.POSITIVE_INFINITY) - requestedRank)
  for (const candidate of efforts.slice(1)) {
    if (requestedRank === undefined) {
      best = candidate
      continue
    }
    const distance = Math.abs((EFFORT_RANK[candidate] ?? Number.POSITIVE_INFINITY) - requestedRank)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * Resolve a bare preset model name across its configured providers. The first
 * route in Models settings order that serves the requested effort, or that
 * declares no selectable efforts, wins. A route with no declared efforts is
 * started without an effort and reported as not applicable. When every readable
 * route declares efforts and none includes the requested one, the first of
 * those serves its nearest supported effort. `provider/model` names bypass this
 * selection by naming their route.
 * @param llm - Live LLM runtime owning exact-route metadata.
 * @param models - Live configured catalog in Models settings order.
 * @param model - Bare model id from the preset definition.
 * @param effort - Effort the definition or the caller requested, if any.
 * @param signal - Tool-call cancellation signal.
 * @returns the selected route and its effective effort, or undefined when no
 *   configured provider advertises the model id.
 * @throws an error naming every candidate provider and why each was skipped,
 *   only when every candidate's model metadata is unreadable.
 */
export async function resolvePresetModelRoute(
  llm: LlmRuntime,
  models: readonly LlmModelInfo[],
  model: string,
  effort: ReasoningEffortId | undefined,
  signal: AbortSignal,
): Promise<PresetModelRoute | undefined> {
  const matches = models.filter(candidate => candidate.id === model)
  if (matches.length === 0) return undefined
  if (effort === undefined) return { route: { provider: matches[0]!.provider, model } }
  const candidates: EffortCandidate[] = []
  for (const match of matches) {
    const route: AllowedModelRoute = { provider: match.provider, model: match.id }
    let info: LlmResolvedModelInfo
    try {
      info = await llm.resolveModelInfo(route.provider, route.model, signal)
    } catch (error: unknown) {
      candidates.push({ route, skip: `model metadata unavailable: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const declared = info.reasoning?.efforts.map(row => row.id)
    // Empty and absent effort lists are the same "not configured" state: the
    // route does not participate in effort filtering.
    candidates.push(declared === undefined || declared.length === 0
      ? { route, skip: undefined }
      : { route, efforts: declared, skip: declared.includes(effort) ? undefined : `supports efforts ${declared.join(', ')}` })
  }
  const serving = candidates.find(candidate => candidate.skip === undefined)
  if (serving !== undefined) {
    return serving.efforts === undefined
      ? { route: serving.route, effortNotApplicable: true }
      : { route: serving.route, effort }
  }
  const lowerable = candidates.find(candidate => candidate.efforts !== undefined && candidate.efforts.length > 0)
  if (lowerable?.efforts !== undefined) {
    const nearest = nearestEffort(lowerable.efforts, effort)
    return { route: lowerable.route, effort: nearest, loweredTo: nearest }
  }
  const rows = candidates.map(candidate => `${candidate.route.provider} (${candidate.skip})`).join(', ')
  throw new Error(
    `no provider of model "${model}" can serve reasoning effort "${effort}": tried ${rows} `
    + `/ 无法为模型 "${model}" 选出支持推理档位 "${effort}" 的提供商：已尝试 ${rows}`,
  )
}

/** Schema shared by the Host setting and its deployment base. */
export const AllowedModelRouteSchema: z<AllowedModelRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** Route-selection authority captured by one delegation definition. */
export interface ModelSelectionPolicy {
  /** Exact provider/model routes authorized for explicit selection. */
  readonly routes: readonly AllowedModelRoute[]
}

/**
 * Stable identity for one provider/model pair.
 * @param route - Exact provider/model route.
 * @returns Opaque key for equality checks.
 */
export function modelRouteKey(route: AllowedModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Reject malformed or duplicate route policy entries at a durable or configuration boundary.
 * @param routes - Candidate exact routes to validate.
 * @returns an assertion that the candidate is a validated exact-route array.
 */
export function assertAllowedModelRoutes(routes: unknown): asserts routes is readonly AllowedModelRoute[] {
  if (!Array.isArray(routes)) {
    throw new Error('subagent model selection requires an array of routes')
  }
  const seen = new Set<string>()
  const candidates: readonly unknown[] = routes
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('provider' in candidate) || typeof candidate.provider !== 'string'
      || !('model' in candidate) || typeof candidate.model !== 'string'
      || candidate.provider.length === 0 || candidate.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const route = { provider: candidate.provider, model: candidate.model }
    const key = modelRouteKey(route)
    if (seen.has(key)) {
      throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`)
    }
    seen.add(key)
  }
}

/**
 * Blank optional route text is the same as omitting the field.
 * @param value - raw model-facing argument.
 * @returns the trimmed value, or `undefined` when omitted or blank.
 */
function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Model-facing child LLM route fields. */
export interface DelegationModelRequest {
  readonly provider?: string
  readonly model?: string
  readonly reasoning_effort?: string
}

/**
 * Whether a call explicitly selects any child LLM value.
 * @param request - Model-facing route fields from the tool call.
 * @returns Whether at least one route or effort field is present.
 */
export function hasDelegationModelRequest(request: DelegationModelRequest): boolean {
  return present(request.provider) !== undefined
    || present(request.model) !== undefined
    || present(request.reasoning_effort) !== undefined
}

/**
 * Merge model-supplied selection fields over configured child defaults.
 * Provider and model form one route and must be supplied together. Changing
 * that route without an effort clears the configured route-owned effort.
 * @param parentOptions - Current parent values that supply missing child values.
 * @param configured - Tool-instance child defaults.
 * @param request - Model-facing route override.
 * @param enabled - Whether this tool instance permits model-facing selection.
 * @returns Child Agent options, preserving omission when no layer contributes one.
 */
export function requestedAgentOptions(
  parentOptions: AgentOptions,
  configured: AgentOptions | undefined,
  request: DelegationModelRequest,
  enabled: boolean,
): AgentOptions | undefined {
  const provider = present(request.provider)
  const model = present(request.model)
  const reasoningEffort = present(request.reasoning_effort)
  if (provider === undefined && model === undefined && reasoningEffort === undefined) return configured
  if (!enabled) {
    throw new Error('child model selection is disabled for this tool instance')
  }
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('child LLM `provider` and `model` must be supplied together — pass both, or omit both (an empty string counts as omitted)')
  }

  const baselineProvider = configured?.provider ?? parentOptions.provider
  const baselineModel = configured?.model ?? parentOptions.model
  const routeChanged = provider !== undefined
    && (provider !== baselineProvider || model !== baselineModel)
  const { reasoningEffort: _configuredReasoningEffort, ...configuredWithoutReasoning } = configured ?? {}
  return {
    ...routeChanged && reasoningEffort === undefined ? configuredWithoutReasoning : configured,
    ...provider === undefined || model === undefined ? {} : { provider, model },
    ...reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
  }
}

/**
 * Enforce a settings-owned route list at the operation that creates the child.
 * Pure inheritance remains outside this policy because no model-facing choice
 * occurred; any explicit route or effort field must resolve to an allowed route.
 * @param policy - Selection authority captured for this Session.
 * @param parentOptions - Current parent values that supply missing child values.
 * @param requested - Effective child options after request/config merging.
 * @param request - Model-facing selection fields from the tool call.
 */
export function assertAllowedModelSelection(
  policy: ModelSelectionPolicy | undefined,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  request: DelegationModelRequest,
): void {
  if (policy === undefined || !hasDelegationModelRequest(request)) return
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  if (policy.routes.some(route => route.provider === provider && route.model === model)) return
  throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`)
}

/**
 * Whether configured Agent options require route validation before delegation.
 * @param options - Tool-instance child defaults.
 * @returns Whether configured provider, model, or effort values must be resolved.
 */
export function hasConfiguredLlmSelection(options: AgentOptions | undefined): boolean {
  return options?.provider !== undefined
    || options?.model !== undefined
    || options?.reasoningEffort !== undefined
}

/**
 * Resolve an effective child route through its live adapter before the child is
 * created. The LLM runtime owns provider lookup, exact-model metadata, effort
 * validation, and adapter defaults.
 * @param llm - Live LLM runtime.
 * @param parentOptions - Current parent values whose compatible fields the child inherits.
 * @param requested - Per-child options after request/config merging.
 * @param signal - Tool-call cancellation signal.
 * @param inheritParentReasoningEffort - Whether an omitted effort may inherit from the parent route.
 */
export async function preflightChildLlmRoute(
  llm: LlmRuntime,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  signal: AbortSignal,
  inheritParentReasoningEffort = true,
): Promise<void> {
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model
  const reasoningEffort = requested?.reasoningEffort
    ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : undefined)
  await llm.resolveCallConfig({
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }, signal)
}
