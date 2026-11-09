/** Model-facing operations over the Host Session service. @module @panedesk/dsh-tool-session-ops */

import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import { brandString } from '@panedesk/dsh-brand'
import type { SessionRequestId, SessionSummary } from '@panedesk/dsh-api-session-controller'
import type {} from '@panedesk/dsh-agent-default-model'
import { SessionId } from '@panedesk/dsh-session'
import { defineTool } from '@panedesk/dsh-tools'
import type {} from '@panedesk/dsh-permission-presets'
import type {} from '@panedesk/dsh-session-projection'
import type {} from '@panedesk/dsh-session-title'
import type {} from '@panedesk/dsh-settings'
import type {} from '@panedesk/dsh-working-directory'
import type {} from '@panedesk/dsh-workspace'
import { en, zh } from './locales.ts'

/** Cordis plugin name. */
export const name = 'tool-session-ops'
/** Existing Host services used by the tools. */
export const inject = ['tools', 'sessionController', 'permissionPresets', 'sessionProjections', 'workingDirectory', 'settings', 'agentDefaultModel', 'workspaceRegistry']

const identitySchema = {
  type: 'object', additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    name: { type: 'string', required: true },
  },
} as const

/** Register Session tools without creating a separate Session lifecycle.
 * @param ctx - Host context carrying the existing Session operations.
 */
export function apply(ctx: Context): void {
  const text = () => {
    const value = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === 'locale')?.value
    const preference: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'preference') : undefined
    return typeof preference === 'string' && preference.split('-')[0]?.toLowerCase() === 'en' ? en : zh
  }
  const list = async (signal: AbortSignal) => (await ctx.sessionController.list({}, signal)).items
    .filter(item => item.origin !== 'subagent')
  const rowName = (item: SessionSummary) => item.projections?.values.title ?? item.sessionId
  const sessionName = (session: Parameters<typeof ctx.workingDirectory.get>[0]) =>
    ctx.sessionProjections.stateOf(session, 'title') ?? session.id
  const render = (_args: unknown, value: Parameters<typeof JSON.stringify>[0]) =>
    [{ type: 'text' as const, text: JSON.stringify(value) }]

  ctx.tools.register(defineTool({
    name: 'session_new',
    description: 'Open a new top-level session in the current or another directory using the existing session service. Returns its session id and current name. An opening prompt starts work; without a name, normal automatic naming applies.',
    parameters: {
      cwd: { type: 'string', description: 'Working directory for the new session. Omit to use your current working directory.' },
      model: { type: 'string', description: 'Exact name or id of an already configured model. Omit to use the remembered default model.' },
      permissionPreset: { type: 'string', description: 'Permission preset name. Omit to use the user\'s remembered preset.' },
      prompt: { type: 'string', description: 'Opening message to start work in the new session. Omit to leave it idle.' },
      name: { type: 'string', description: 'Explicit session name, overriding automatic naming. Omit to keep normal automatic naming.' },
    },
    output: { schema: identitySchema, render },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error(text().requiresAgent)
      exec.signal.throwIfAborted()
      const workspace = await ctx.workspaceRegistry.create(args.cwd ?? ctx.workingDirectory.get(exec.agent.session))
      const { sessionId } = await ctx.sessionController.create({ workspaceId: workspace.id })
      if (args.model !== undefined) {
        const catalog = await ctx.sessionController.modelCatalog()
        const selection = catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model })))
          .find(item => item.model.id === args.model || item.model.name === args.model)
        if (selection === undefined) throw new Error(text().modelNotFound(args.model))
        exec.signal.throwIfAborted()
        await ctx.sessionController.selectModel({ sessionId, provider: selection.provider, model: selection.model.id })
      }
      const result = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in result) throw result.error
      if (args.permissionPreset !== undefined) ctx.permissionPresets.set(result.agent.session, args.permissionPreset)
      if (args.prompt !== undefined) {
        await ctx.sessionController.prompt({
          sessionId, requestId: brandString<SessionRequestId>(randomUUID()), mode: 'next-step',
          content: [{ type: 'text', text: args.prompt }],
        }, exec.signal)
      }
      if (args.name !== undefined) {
        exec.signal.throwIfAborted()
        await ctx.sessionController.rename({ sessionId, title: args.name })
      }
      return { sessionId, name: sessionName(result.agent.session) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_rename',
    description: 'Rename your own session or another session by id using the existing session naming service.',
    parameters: {
      sessionId: { type: 'string', description: 'Session id to rename. Omit to rename your own session.' },
      name: { type: 'string', required: true, description: 'New explicit session name.' },
    },
    output: { schema: identitySchema, render },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error(text().requiresAgent)
      exec.signal.throwIfAborted()
      const sessionId = args.sessionId === undefined ? exec.agent.id : SessionId(args.sessionId)
      const renamed = await ctx.sessionController.rename({ sessionId, title: args.name })
      return { sessionId, name: renamed.title }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_list',
    description: 'List all top-level sessions, most recently active first, with each session id, name, working directory, running state, and model. Subagents are excluded; ordinary conversation forks remain top-level sessions.',
    parameters: {},
    output: {
      schema: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            ...identitySchema.properties,
            cwd: { type: 'string' },
            running: { type: 'boolean', required: true },
            model: {
              type: 'object', required: true, additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render,
    },
    async execute(_args, exec) {
      return (await list(exec.signal)).map(item => {
        const model = item.projections?.values.modelSelection?.next ?? ctx.agentDefaultModel.currentSelection()
        const cwd = item.projections?.values.workingDirectory ?? item.cwd
        return {
          sessionId: item.sessionId, name: rowName(item), running: item.running,
          ...(cwd === undefined ? {} : { cwd }),
          model: { provider: model.provider, model: model.model },
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_send',
    description: 'Send a message to a top-level session by id or exact name. Duplicate names select the most recently active session. The message identifies your session; a busy recipient queues it for the next step without interruption. Returns acceptance, not a reply.',
    parameters: {
      target: { type: 'string', required: true, description: 'Recipient session id or exact session name. Use session_list to discover sessions.' },
      text: { type: 'string', required: true, description: 'Message text to deliver.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ...identitySchema.properties, accepted: { type: 'boolean', required: true } },
      },
      render,
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error(text().requiresAgent)
      const items = await list(exec.signal)
      const target = items.find(item => item.sessionId === args.target)
        ?? items.find(item => rowName(item) === args.target)
      if (target === undefined) throw new Error(text().sessionNotFound(args.target))
      const accepted = await ctx.sessionController.prompt({
        sessionId: target.sessionId, requestId: brandString<SessionRequestId>(randomUUID()), mode: 'next-step',
        content: [{ type: 'text', text: text().from(sessionName(exec.agent.session)) + args.text }],
      }, exec.signal)
      return { sessionId: target.sessionId, name: rowName(target), accepted: accepted.accepted }
    },
  }))
}
