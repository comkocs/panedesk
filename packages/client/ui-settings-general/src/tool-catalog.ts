/** Read registered tool definitions without applying ordinary-session preferences. */
import type { Context } from '@panedesk/cordis'
import { Remote, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
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
    const presetOnly = new Map<string, string[]>()
    const presets = this.ctx.get('agentPresets')
    if (presets) {
      // Ordinary sessions run the default preset, so only other presets' extra tools are marked.
      const rows = (await presets.list()).filter(preset => !preset.broken)
        .sort((a, b) => Number(b.id === presets.defaultId) - Number(a.id === presets.defaultId))
      for (const preset of rows) {
        await using scope = await presets.acquireScope(preset.id)
        for (const tool of this.ctx.tools.schemas(scope.key)) {
          if (tools.has(tool.name) && !presetOnly.has(tool.name)) continue
          tools.set(tool.name, tool)
          if (preset.id !== presets.defaultId) presetOnly.set(tool.name, [...presetOnly.get(tool.name) ?? [], preset.name ?? preset.id])
        }
      }
    }
    return [...tools.values()].map(tool => {
      const text = JSON.stringify({ description: tool.description, parameters: tool.parameters })
      const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
      return {
        name: tool.name,
        description: tool.description.split(/\n|\.\s/u)[0]!,
        tokens: cjk + Math.ceil((Array.from(text).length - cjk) / 4),
        ...presetOnly.has(tool.name) ? { presets: presetOnly.get(tool.name) } : {},
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }
}
