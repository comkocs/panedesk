/** Mounts one Claude Code agent's instruction body as its preset's persona section. */
import type { Context } from '@panedesk/cordis'
import { CLAUDE_TOOL_NAMES } from './claude-agents.ts'

/** Cordis plugin name. */
export const name = 'claude-agent-instructions'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt', 'tools']

/** Plugin config: the instruction text read from the agent definition. */
export interface Config {
  /** Body of the agent definition, rendered verbatim. */
  text: string
  /** Mapped tool allowlist from the imported definition. */
  allowedTools: string[]
  /** Permitted explicit child preset ids; omission leaves delegation types unrestricted. */
  agentTypes?: string[]
}

/**
 * Register the instruction section for the mounting context's scope.
 * @param ctx - the preset scope the section is visible in.
 * @param config - the instruction text.
 */
export function apply(ctx: Context, config: Config): void {
  const allowed = new Set(config.allowedTools)
  const capabilities = new Set(Object.values(CLAUDE_TOOL_NAMES).flat())
  ctx.effect(() => ctx.tools.guard((exec, capability) => {
    if (!capabilities.has(capability)) return undefined
    if (!allowed.has(capability)) return `Agent definition denies tool "${exec.name}"`
    if (capability === 'subagent' && config.agentTypes !== undefined) {
      const args = exec.arguments as { agent_preset?: string }
      if (args.agent_preset === undefined || !config.agentTypes.includes(args.agent_preset)) {
        return `Agent definition permits child types: ${config.agentTypes.join(', ')}; select one with agent_preset`
      }
    }
    return undefined
  }))
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'claude-agent:instructions',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: config.text,
  }), 'claude-agent.instructions()')
}

/** Cordis plugin that publishes one Claude agent instruction section. */
export default { name, inject, apply }
