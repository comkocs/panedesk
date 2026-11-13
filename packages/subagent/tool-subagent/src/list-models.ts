/** Model-facing discovery of all configured child LLM routes. */

import type { Context } from '@panedesk/cordis'
import { defineTool } from '@panedesk/dsh-tools'
import { scopeOf } from '@panedesk/dsh-scope'
import { configuredModels, resolveModelRoute } from './model-selection.ts'

/**
 * Register discovery independently of Session age or stored preferences.
 * @param ctx - Context whose tool registry owns the discovery definition.
 */
export function registerListSubagentModels(ctx: Context): void {
  if (ctx.tools.get('list_subagent_models', scopeOf(ctx)) !== undefined) return
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_subagent_models',
    description: 'List all configured subagent models. Optionally filter by provider, or inspect a model and its reasoning efforts. A model name must identify one provider unless provider is supplied.',
    parameters: {
      provider: { type: 'string', description: 'Optional registered LLM provider id. Omit it, or pass an empty string, to list every configured model.' },
      model: { type: 'string', description: 'Optional exact model id to inspect. Omit it, or pass an empty string, to list models instead of inspecting one.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    async execute(args, exec) {
      const llm = ctx.get('llm')
      if (llm === undefined) throw new Error('cannot discover child LLM routes because the `llm` service is unavailable')
      const models = await configuredModels(llm)
      const line = (model: typeof models[number]): string =>
        `${model.provider}/${model.id} — ${model.name}${model.description === undefined ? '' : `: ${model.description}`}`
      const blank = (value: string | undefined): string | undefined => {
        const trimmed = value?.trim()
        return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
      }
      const modelId = blank(args.model)
      const providerId = blank(args.provider)
      if (modelId === undefined) {
        const selected = providerId === undefined ? models : models.filter(model => model.provider === providerId)
        return selected.map(line).join('\n') || '(no configured models)'
      }
      const route = resolveModelRoute(models, modelId, providerId)
      const model = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
      const efforts = model.reasoning?.efforts.map(effort =>
        `${effort.id}${model.reasoning?.defaultEffort === effort.id ? ' (default)' : ''} — ${effort.name}`,
      ).join('\n') || '(no advertised reasoning efforts)'
      return `${line(model)}\nReasoning efforts:\n${efforts}`
    },
  })))
}
