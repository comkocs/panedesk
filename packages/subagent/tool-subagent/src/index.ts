/**
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider lifecycle controls tool registration and context-sensitive schema
 * wording. Every delegation starts a managed activation and returns its child
 * id; the subagent runtime owns result delivery and resource cleanup.
 * @module @panedesk/dsh-tool-subagent
 */

import type { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import { scopeChainOf, scopeOf } from '@panedesk/dsh-scope'
import { defineTool } from '@panedesk/dsh-tools'
import type { ToolDefinition } from '@panedesk/dsh-tools'
import type { Agent, AgentOptions } from '@panedesk/dsh-agent'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import type { ContentBlock } from '@panedesk/dsh-llm'
import type { Session } from '@panedesk/dsh-session'
import {
  SubagentError,
  assertSubagentMaxDepth,
  delegationDepthOf,
  parentAgentOptionsForDelegation,
} from '@panedesk/dsh-subagent'
import type { SubagentProvider } from '@panedesk/dsh-subagent'
import {
  configuredModels,
  resolveModelRoute,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from './model-selection.ts'
import type { DelegationModelRequest } from './model-selection.ts'
import { registerListSubagentModels } from './list-models.ts'
import { SubagentPresetSelection, type PresetSelectionConfig, type PresetSelectionRequest } from './preset-selection.ts'
import {
  subagentModelSelectionProjectionDefinition,
} from './model-selection-state.ts'

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections']

// Definition identity keeps shared guidance scoped to the actual visible tools,
// including scoped overrides and independently loaded tool registries.
const delegationTools = new Set<ToolDefinition>()

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config extends PresetSelectionConfig {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Retired setting accepted for existing compositions; model selection is always available.
   */
  modelSelectionSettings?: boolean
  /** Expose model-authored delivery declarations; inherited preset composition keeps forks identical to their parent. */
  deliveryDeclarations?: boolean
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Maximum child depth: a non-negative safe integer (`0` forbids delegation),
   * or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment. Omission reads
   * the current Host subagent depth setting (default `1`) at each delegation.
   */
  maxDepth?: number | 'provider-managed'
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  modelSelectionSettings: z.boolean().default(false),
  deliveryDeclarations: z.boolean().default(false),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as {
    provider: string
    model: string
    reasoningEffort: ReturnType<typeof ReasoningEffortId>
    maxTokens: number
  }),
  agentPreset: z.string().min(1),
  allowedAgentPresets: (z.array(z.string().min(1)).min(1) as z<string[] | undefined>).default(undefined),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]),
})

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task in a separate context; receive results, not intermediate steps.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

/**
 * Install one delegation-tool composition.
 * Standing preset choices are validated for each Agent before its tool is installed.
 * @param ctx - Context that owns the registrations.
 * @param config - delegation-tool configuration.
 * @param session - unpublished Session supplied by a direct Agent setup; omit for a standing composition.
 */
export async function apply(ctx: Context, config: Config, session?: Session): Promise<void> {
  for (const field of ['persona', 'toolFilter']) {
    if (Object.hasOwn(config, field)) {
      throw new Error(`tool-subagent: ${field} is no longer supported; configure persona and tool plugins in an Agent Preset and select it with agentPreset (spawn only)`)
    }
  }
  const presets = new SubagentPresetSelection(config)
  if (presets.configured && ctx.get('agentPresets') === undefined) {
    throw new Error('tool-subagent: agent preset selection requires the agent-presets service')
  }
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  const toolName = config.toolName ?? 'subagent'

  ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)

  const assertSubagentProviderConfiguration = (subagentProvider: SubagentProvider): void => {
    presets.assertProvider(subagentProvider)
    if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== undefined && !subagentProvider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    if (config.agentOptions !== undefined && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`,
      )
    }

  }

  // Validate provider-owned config outside the optional LLM binding so an
  // invalid provider always rejects its registration or this plugin's load.
  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider)
  })
  const initialProvider = ctx.subagents.getProvider(config.provider)
  if (initialProvider !== undefined) assertSubagentProviderConfiguration(initialProvider)

  const install = (runtimeCtx: Context): void => {
    registerListSubagentModels(runtimeCtx)
    // Load order and HMR replacement can change provider availability while
    // this fiber remains active.
    let mounted: {
      subagentProvider: SubagentProvider
      definition: ToolDefinition
      disposeTool: () => void
      admissionEnabled: boolean
    } | undefined
    const mount = (subagentProvider: SubagentProvider): void => {
      assertSubagentProviderConfiguration(subagentProvider)
      const admissionEnabled = (runtimeCtx.subagents.queuesRootOverflow || runtimeCtx.get('subagentAdmission') !== undefined)
      const wording = providerWording(subagentProvider.inheritsParentContext)
      const providerRouteDefaults = subagentProvider.agentRouteDefaults
      const selectionDescription = providerRouteDefaults !== undefined
        ? ' Omitted LLM selections use configured child and provider route defaults.'
        : ' Omitted LLM selections use configured child defaults, inheriting compatible missing values from the parent.'
      const choiceDescription = selectionDescription
          + ' Inspect routes and efforts with `list_subagent_models` before selecting. A changed route without an effort uses the model default.'
          + (subagentProvider.inheritsParentContext
            ? ' Changing the route can prevent provider-side reuse of the inherited conversation prefix.'
            : '')
      const definition = defineTool({
        name: toolName,
        description: wording.description
          + ' Returns its id immediately; completion is notified.'
          + (subagentProvider.prepareContinuable !== undefined
            ? ' Use `send_message` for child results, steering, or continuation after completion.'
            : ' Completion includes the final answer; follow-up messages are unsupported.')
          + choiceDescription,
        parameters: {
          cwd: {
            type: 'string',
            description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent.',
          },
          ...config.deliveryDeclarations === true ? {
            deliveryPaths: {
              type: 'array' as const,
              items: { type: 'string' as const },
              description: 'Declared delivery files within the authorized workspace. The runtime checks them at settlement and never replaces them with errors.',
            },
          } : {},
          description: {
            type: 'string',
            required: true,
            description: 'A short (3-5 word) description of the delegated task, for display.',
          },
          prompt: {
            type: 'string',
            required: true,
            description: wording.promptDescription,
          },
          agent_preset: {
            type: 'string',
            ...presets.choices?.length ? { enum: [...presets.choices] } : {},
            description: presets.description,
          },
          provider: {
            type: 'string',
            description: 'Optional LLM provider id to disambiguate model. Requires model.',
          },
          model: {
            type: 'string',
            description: 'Exact model id from any configured provider. Overrides the preset model; omit to use preset, configured, or parent defaults.',
          },
          reasoning_effort: {
            type: 'string',
            description: 'Optional adapter-owned reasoning effort for the selected model.',
          },

        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              model: { type: 'object', additionalProperties: false, properties: {
                provider: { type: 'string', required: true }, model: { type: 'string', required: true },
              } },
              kind: admissionEnabled
                ? { type: 'string', required: true, enum: ['activation', 'queued'] }
                : { type: 'string', required: true, const: 'activation' },
              subagentId: admissionEnabled ? { type: 'string' } : { type: 'string', required: true },
              ticketId: { type: 'string' },
              position: { type: 'number' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.kind === 'queued'
            ? value.position === undefined
              ? `queued subagent ${value.ticketId}; register a wait for this ticket and end the turn instead of retrying`
              : `queued subagent ${value.ticketId} at position ${value.position}; continue other work or close an idle child to free capacity`
            : `started subagent ${value.subagentId}${value.model === undefined ? '' : `; model ${value.model.provider}/${value.model.model}`}` }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) {
            // Non-agent callers provide no parent for delegation ownership.
            throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
          }

          if (runtimeCtx.get('agentPresets') !== undefined) await presets.validate(runtimeCtx)
          const agentPreset = presets.resolve(args as PresetSelectionRequest)
          const parentOptions = parentAgentOptionsForDelegation(parent)
          const registry = parent.ctx.get('agentPresets')
          const definition = agentPreset === undefined ? undefined : await registry?.resolve(agentPreset)
          let modelRequest: DelegationModelRequest = args
          if (args.model !== undefined || definition?.model !== undefined) {
            const llm = runtimeCtx.get('llm')
            if (llm === undefined) throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
            const models = await configuredModels(llm)
            if (args.model !== undefined) {
              modelRequest = { ...args, ...resolveModelRoute(models, args.model, args.provider) }
            } else if (args.provider === undefined && definition?.model !== undefined) {
              const available = models.some(candidate => candidate.id === definition.model)
              const route = available
                ? resolveModelRoute(models, definition.model)
                : {
                    ...parentOptions.provider === undefined ? {} : { provider: parentOptions.provider },
                    ...parentOptions.model === undefined ? {} : { model: parentOptions.model },
                  }
              const effort = args.reasoning_effort ?? (available ? definition.reasoningEffort : parentOptions.reasoningEffort)
              modelRequest = { ...route, ...effort === undefined ? {} : { reasoning_effort: effort } }
            }
          }
          const requiresRoutePreflight = hasDelegationModelRequest(modelRequest)
            || hasConfiguredLlmSelection(config.agentOptions)
          const configuredChildAgentOptions = requiresRoutePreflight && providerRouteDefaults !== undefined
            ? { ...providerRouteDefaults, ...config.agentOptions }
            : config.agentOptions
          let requestedChildAgentOptions = requestedAgentOptions(
            parentOptions,
            configuredChildAgentOptions,
            modelRequest,
            true,
          )
          if (subagentProvider.prepareContinuable !== undefined) {
            const registry = parent.ctx.get('agentPresets')
            const definition = agentPreset === undefined ? registry?.composedPolicy(parent.ctx)
              : await registry?.resolve(agentPreset)
            const policy = definition?.executionPolicy
            if (policy !== undefined) {
              for (const field of ['provider', 'model', 'reasoningEffort'] as const) {
                if (requestedChildAgentOptions?.[field] !== undefined && requestedChildAgentOptions[field] !== policy[field]) {
                  throw new Error(`Execution policy denies ${field} "${requestedChildAgentOptions[field]}"; definition requires "${policy[field]}"`)
                }
              }
              requestedChildAgentOptions = { ...requestedChildAgentOptions, provider: policy.provider, model: policy.model,
                reasoningEffort: ReasoningEffortId(policy.reasoningEffort) }
            }
          }
          if (requiresRoutePreflight) {
            const llm = runtimeCtx.get('llm')
            if (llm === undefined) {
              throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
            }
            try {
              await preflightChildLlmRoute(
                llm,
                parentOptions,
                requestedChildAgentOptions,
                exec.signal,
                providerRouteDefaults === undefined,
              )
            } catch (error: unknown) {
              if (error instanceof Error) error.message = `subagent failed during model-connection: ${error.message}`
              throw error
            }
            if (runtimeCtx.subagents.getProvider(config.provider) !== subagentProvider) {
              throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
            }
          }
          exec.signal.throwIfAborted()
          const maxDepth = runtimeCtx.subagents.resolveMaxDepth(config.maxDepth)
          const request = {
            ...args.cwd === undefined ? {} : { cwd: args.cwd },
            ...config.deliveryDeclarations !== true || args.deliveryPaths === undefined ? {} : { deliveryPaths: args.deliveryPaths },
            prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
            parent,
            ...agentPreset === undefined ? {} : { agentPreset },
            ...requestedChildAgentOptions !== undefined ? { agentOptions: requestedChildAgentOptions } : {},
            ...maxDepth !== undefined ? { maxDepth } : {},
          }

          const spec = {
            provider: config.provider,
            label: args.description,
            request,
            signal: exec.signal,
            delivery: 'parent' as const,
          }
          const started = await (!runtimeCtx.subagents.queuesRootOverflow && runtimeCtx.get('subagentAdmission') === undefined
            ? runtimeCtx.subagents.startActivation(spec)
            : runtimeCtx.subagents.requestActivation(spec))
          if ('status' in started) return { kind: 'queued' as const, ticketId: started.ticketId,
            ...started.position === undefined ? {} : { position: started.position } }
          const ready = await started.ready
          if (ready?.failureStage !== undefined) {
            throw new SubagentError(`subagent ${started.childId} failed during ${ready.failureStage}`, 'SUBAGENT_START_FAILED')
          }
          return { kind: 'activation' as const, subagentId: started.childId,
            ...ready?.model === undefined ? {} : { model: ready.model } }
        },
      })
      definition.guardName = 'subagent'
      const disposeTool = runtimeCtx.effect(() => {
        const unregister = runtimeCtx.tools.register(definition)
        delegationTools.add(definition)
        return () => {
          delegationTools.delete(definition)
          unregister()
        }
      })
      // oxlint-disable-next-line typescript/no-misused-promises -- Tool and guidance disposal are synchronous.
      mounted = { subagentProvider, definition, disposeTool, admissionEnabled }
    }

    runtimeCtx.on('internal/service', (name) => {
      if (name !== 'subagentAdmission' || mounted === undefined
        || mounted.admissionEnabled === ((runtimeCtx.subagents.queuesRootOverflow || runtimeCtx.get('subagentAdmission') !== undefined))) return
      const { subagentProvider } = mounted
      mounted.disposeTool()
      mounted = undefined
      mount(subagentProvider)
    })

    // Register listeners before checking presence so no synchronous change is missed.
    runtimeCtx.on('subagent/provider-added', (subagentProvider) => {
      if (subagentProvider.name === config.provider && mounted === undefined) mount(subagentProvider)
    })
    runtimeCtx.on('subagent/provider-removed', (name) => {
      if (name !== config.provider || mounted === undefined) return
      mounted.disposeTool()
      mounted = undefined
    })
    const present = runtimeCtx.subagents.getProvider(config.provider)
    if (present !== undefined) {
      mount(present)
    } else {
      // A backend fiber may activate later; a misspelled provider remains visible in this log.
      runtimeCtx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
    }
    runtimeCtx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: runtimeCtx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
      text: (context) => {
        if (mounted === undefined) return ''
        const visible = [...delegationTools]
          .filter(tool => runtimeCtx.tools.get(tool.name, context.scope) === tool)
          .map(tool => tool.name)
          .sort()
        if (visible[0] !== toolName) return ''
        const names = visible.map(name => `\`${name}\``).join(' or ')
        return `Start independent delegations with ${names} together in one assistant message and continue useful work while they run.`
      },
    })
    runtimeCtx.systemPrompt.context({
      name: `tool:${toolName}:depth`,
      order: runtimeCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
      text: (context) => {
        if (context.agent === undefined || mounted === undefined
          || runtimeCtx.tools.get(toolName, context.scope) !== mounted.definition) return ''
        const maxDepth = runtimeCtx.subagents.resolveMaxDepth(config.maxDepth)
        if (maxDepth === undefined) return ''
        const depth = delegationDepthOf(context.agent)
        if (depth < maxDepth) return ''
        return `Delegation depth for \`${toolName}\`: current ${depth}, maximum ${maxDepth}, remaining levels 0.`
          + ` Do not call \`${toolName}\` at this depth; carry out the work directly.`
      },
    })
  }

  const compositionScope = scopeOf(ctx)
  const registryChoices = ctx.get('agentPresets') !== undefined
  const validatePresets = presets.configured || registryChoices
  if (validatePresets && (session !== undefined || compositionScope === undefined)) await presets.validate(ctx)

  if (!validatePresets || session !== undefined || compositionScope === undefined) {
    install(ctx)
    return
  }

  if (compositionScope === undefined) {
    throw new Error('tool-subagent: standing preset selection requires a scoped preset Context')
  }
  const agents = ctx.get('agents')
  /* v8 ignore next -- shipped preset compositions always include the Agent registry. */
  if (agents === undefined) throw new Error('tool-subagent: standing preset selection requires the Agent registry')
  const scopedInstalls = new WeakMap<Agent, ReturnType<Context['inject']>>()
  const installing = new WeakSet<Agent>()
  const belongsToComposition = (candidate: Agent): boolean =>
    scopeChainOf(scopeOf(candidate.ctx)).includes(compositionScope)
  const installScoped = (candidate: Agent): ReturnType<Context['inject']> | undefined => {
    const existing = scopedInstalls.get(candidate)
    if (existing !== undefined) return existing
    if (installing.has(candidate)) return
    // Reserve before the injected fiber runs: tool registration emits
    // `tools/change` synchronously, which re-enters the reconciliation below.
    installing.add(candidate)
    let fiber: ReturnType<Context['inject']>
    try {
      fiber = candidate.ctx.inject(['tools', 'subagents', 'systemPrompt'], async (runtimeCtx) => {
        if (validatePresets) await presets.validate(ctx)
        install(runtimeCtx)
      })
    } finally {
      installing.delete(candidate)
    }
    scopedInstalls.set(candidate, fiber)
    return fiber
  }
  const removeScoped = (candidate: Agent): void => {
    const fiber = scopedInstalls.get(candidate)
    if (fiber === undefined) return
    scopedInstalls.delete(candidate)
    /* v8 ignore next 3 -- Cordis Fiber disposal contains registration cleanup failures; this is the final diagnostic sink. */
    void fiber.dispose().catch((error: unknown) => {
      ctx.logger.warn(`tool-subagent: failed to remove recomposed Agent "${candidate.id}" definitions: ${String(error)}`)
    })
  }
  const reconcileComposedAgents = (): void => {
    for (const candidate of agents.list()) {
      if (belongsToComposition(candidate)) installScoped(candidate)
      else removeScoped(candidate)
    }
  }
  // The preset-scoped listener admits descendant Agents and installs the
  // tool definition in each Agent's own scope, independent of Session history.
  ctx.on('agent/created', async ({ agent: created }) => {
    await installScoped(created)
  })
  ctx.on('agent/disposed', ({ agent: disposed }) => { removeScoped(disposed) })
  // Reparenting an Agent between standing presets changes its inherited tool
  // set and emits `tools/change`; reconcile the Agent-owned override with the
  // new ancestry. Other registry changes are idempotent no-ops here.
  ctx.on('tools/change', reconcileComposedAgents)
  reconcileComposedAgents()
}
