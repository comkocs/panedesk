/** Read registered tool definitions without applying ordinary-session preferences. */
import type { Context } from '@panedesk/cordis'
import { Remote, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import { estimateContent } from '@panedesk/dsh-token-meter/estimate'
import type {} from '@panedesk/dsh-tools'
import type {} from '@panedesk/dsh-agent-preset-registry'
import type { ToolCatalogEntry } from './types.ts'

declare module '@panedesk/cordis' {
  interface Context { toolCatalog: ToolCatalog }
}

/** Settings-only catalog; estimates include descriptions and parameter structure. */
export default class ToolCatalog extends TypertRemoteService {
  static inject = ['tools']
  constructor(ctx: Context) { super(ctx, 'toolCatalog') }

  /** Read the available tools independently of the user's disabled list.
   * @returns Tool names, description summaries, and approximate context tokens.
   */
  @Remote
  async list(): Promise<ToolCatalogEntry[]> {
    const tools = new Map(this.ctx.tools.schemas().map(tool => [tool.name, tool]))
    const presets = this.ctx.get('agentPresets')
    if (presets) {
      for (const preset of await presets.list()) {
        if (preset.broken) continue
        await using scope = await presets.acquireScope(preset.id)
        for (const tool of this.ctx.tools.schemas(scope.key)) tools.set(tool.name, tool)
      }
    }
    return [...tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description.split(/\n|\.\s/u)[0]!,
      tokens: estimateContent([{ type: 'text', text: JSON.stringify({ description: tool.description, parameters: tool.parameters }) }]),
    })).sort((a, b) => a.name.localeCompare(b.name))
  }
}
