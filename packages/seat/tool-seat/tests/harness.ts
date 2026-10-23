import { Context } from '@panedesk/cordis'
import AgentRegistry, { type Agent } from '@panedesk/dsh-agent'
import SessionStore, { SessionId } from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SystemPrompt from '@panedesk/dsh-system-prompt'
import ToolRuntime from '@panedesk/dsh-tools'
import { ToolCallId } from '@panedesk/dsh-llm'
import { createInboxStub } from '@panedesk/dsh-agent-loop-testkit'

/** Real tool executor with a minimal live-agent test double. */
export async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  const session = ctx.sessions.create(SessionId('session-a'))
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) { this.inbox.append('next-step', input) }, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  let counter = 0
  return { ctx, agent, execute: (name: string, args: unknown) => {
    return ctx.agents.withInitiator(agent, () => ctx.tools.execute({ name, arguments: args, agent,
      callId: ToolCallId(`call-${++counter}`), signal: new AbortController().signal }))
  } }
}
