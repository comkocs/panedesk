/** Live registry preset choices for one delegation tool. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-agent-preset-registry'
import type { SubagentProvider } from '@panedesk/dsh-subagent'

/** Optional default and model-selectable preset ids for a spawn tool. */
export interface PresetSelectionConfig {
  /** Default independent preset; omission inherits the parent when the model makes no selection. */
  agentPreset?: string
  /** Retired allowlist accepted for existing compositions; all usable presets are offered. */
  allowedAgentPresets?: string[] | undefined
}

/** Untrusted preset selection from model/tool JSON. */
export interface PresetSelectionRequest {
  readonly agent_preset?: unknown
}

/** Validates configured references and resolves model input against the registry. */
export class SubagentPresetSelection {
  private descriptions: string[] = []
  private registeredChoices: string[] | undefined

  constructor(private readonly config: PresetSelectionConfig) {}

  /** Whether this tool requires the preset service and an independently composing provider. */
  get configured(): boolean {
    return this.config.agentPreset !== undefined
  }

  /** Preset ids advertised in the model parameter. */
  get choices(): readonly string[] | undefined {
    return this.registeredChoices
  }

  /** Model-visible selection guidance and configured preset descriptions. */
  get description(): string {
    const fallback = this.config.agentPreset === undefined
      ? 'Omit to inherit the parent agent\'s current preset.'
      : `Omit to use ${this.config.agentPreset}.`
    return `Agent preset for this child. ${fallback}`
      + (this.descriptions.length === 0 ? '' : ` Available presets: ${this.descriptions.join('; ')}`)
  }

  /**
   * Read configured preset declarations before publishing the tool; mounting validates their activation.
   * @param ctx - Tool composition containing the preset service.
   */
  async validate(ctx: Context): Promise<void> {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) throw new Error('tool-subagent: agent preset selection requires the agent-presets service')
    const available = (await presets.list()).filter(preset => preset.broken === undefined)
    this.registeredChoices = available.map(preset => preset.id)
    this.descriptions = available.map(preset => `${preset.id}: ${preset.description ?? preset.name ?? 'No description provided.'}`)
    if (this.config.agentPreset !== undefined && !this.registeredChoices.includes(this.config.agentPreset)) {
      throw new Error(`tool-subagent: unavailable default preset "${this.config.agentPreset}"`)
    }
  }

  /**
   * Reject independent selection for providers that inherit conversation history or lack support.
   * @param provider - Currently registered delegation provider.
   */
  assertProvider(provider: SubagentProvider): void {
    if (this.configured && (!provider.capabilities.agentPreset || provider.inheritsParentContext)) {
      throw new Error(`tool-subagent: provider "${provider.name}" does not support independent agent preset selection`)
    }
  }

  /**
   * Validate model input and apply the deployment default.
   * @param request - Model-supplied tool arguments.
   * @returns Selected preset id, or omission to inherit the parent.
   */
  resolve(request: PresetSelectionRequest): string | undefined {
    const id = request.agent_preset
    if (id === undefined) return this.config.agentPreset
    if (this.choices === undefined) throw new Error('agent_preset selection is disabled for this tool instance')
    if (typeof id !== 'string' || !this.choices.includes(id)) {
      throw new Error(`agent_preset must be one of: ${this.choices.join(', ')}`)
    }
    return id
  }
}
