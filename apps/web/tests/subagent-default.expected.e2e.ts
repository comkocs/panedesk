/** The default Web queue adds only its declared result fields to the upstream PTC prompt. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createUserMessage } from '@panedesk/dsh-llm'
import type {} from '@panedesk/dsh-api-session-controller'
import type {} from '@panedesk/dsh-subagent'
import { formatSystemPromptSnapshot, normalizedSystemPrompts } from '@panedesk/dsh-session-snapshot'
import { withDefaultSubagentQueue } from '../../../snapshots/subagent-default.ts'
import { fixtureUserPrompts, launchWebScaffold, rawSessionLog } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

it('the default web subagent queue adds only queue result fields to the upstream prompt', async () => {
  const directory = fileURLToPath(new URL('../../../snapshots/web/ptc-round/', import.meta.url))
  const fixture = join(directory, 'session.v4.jsonl')
  const upstream = await readFile(join(directory, 'system-prompt.expected.md'), 'utf8')
  const scaffold = await launchWebScaffold({
    agentPresets: { default: 'ptc' }, replayFixture: fixture, compareReplaySession: false,
  })
  try {
    const { sessionId } = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Created session has no agent')
    const prompt = fixtureUserPrompts(await readFile(fixture, 'utf8'))[0]
    if (prompt === undefined) throw new Error('Upstream fixture has no user prompt')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await scaffold.ctx.sessions.flush(agent.session)
    const prompts = normalizedSystemPrompts(rawSessionLog(agent.session), {
      sessionIds: [String(sessionId)], cwd: scaffold.workspaceCwd,
    }).map(value => value.split(REPO_ROOT).join('{{sourceRoot}}').split(scaffold.baseUrl).join('{{webUrl}}'))
    expect(prompts).toHaveLength(1)
    expect(formatSystemPromptSnapshot(prompts[0]!)).toBe(withDefaultSubagentQueue(upstream))
    expect(scaffold.ctx.subagents.resolveMaxDepth()).toBe(3)
    expect(scaffold.ctx.subagents.queuesRootOverflow).toBe(true)
  } finally {
    await scaffold.close()
  }
})
