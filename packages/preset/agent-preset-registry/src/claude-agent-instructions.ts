/** Mounts one Claude Code agent's instruction body as its preset's persona section. */
import type { Context } from '@panedesk/cordis'

/** Cordis plugin name. */
export const name = 'claude-agent-instructions'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** Plugin config: the instruction text read from the agent definition. */
export interface Config {
  /** Body of the agent definition, rendered verbatim. */
  text: string
}

/**
 * Register the instruction section for the mounting context's scope.
 * @param ctx - the preset scope the section is visible in.
 * @param config - the instruction text.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'claude-agent:instructions',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: config.text,
  }), 'claude-agent.instructions()')
}

/** Cordis plugin that publishes one Claude agent instruction section. */
export default { name, inject, apply }
