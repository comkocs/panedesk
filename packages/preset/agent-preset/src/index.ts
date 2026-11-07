/** A declarative preset row in an ordinary Cordis composition. */
import { Context, Service } from '@panedesk/cordis'
import { EntryGroup } from '@panedesk/cordis-plugin-loader'
import z from '@panedesk/schemastery'
import type { PresetDefinition } from '@panedesk/dsh-agent-preset-registry'
import type {} from '@panedesk/dsh-agent-preset-registry'

/** Definition submitted to the preset registry. */
export type Config = PresetDefinition

/** Registers child plugin configuration without owning Agents using older revisions. */
export default class AgentPreset {
  static inject = ['agentPresets']
  /** Preserve child expressions until their own plugins activate. */
  static readonly [EntryGroup.key] = true
  static Config: z<Config> = z.object({
    id: z.string().required(),
    name: z.string(),
    description: z.string(),
    order: z.number(),
    executionPolicy: (z.object({
      provider: z.string().min(1).required(),
      model: z.string().min(1).required(),
      reasoningEffort: z.string().min(1).required(),
      allowedTools: z.array(z.string().min(1)).required(),
      rulesId: z.string().min(1).required(),
      version: z.string().min(1).required(),
      digest: z.string().min(1).required(),
    }) as z<Config['executionPolicy']>).default(undefined),
    // Cordis owns individual plugin schemas; the registry validates entry structure.
    plugins: z.array(z.any()).required(),
  }) as z<Config>

  private readonly registered: Promise<() => Promise<void>>

  constructor(private readonly ctx: Context, private readonly config: Config) {
    // Record the id before this fiber yields. Sibling rows that inject the same
    // registry validate during the same activation turn; waiting for Service.init
    // lets them observe an empty roster.
    this.registered = this.ctx.agentPresets.register(this.config)
  }

  async* [Service.init]() {
    yield await this.registered
  }
}
