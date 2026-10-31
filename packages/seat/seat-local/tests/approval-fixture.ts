/** Real tool approval suspended inside a Loader-owned seat turn. */
import { createUserMessage, ToolCallId, type StreamChunk } from '@panedesk/dsh-llm'
import type { ApprovalOutcome } from '@panedesk/dsh-user-approval'
import * as Tools from '../../tool-seat/src/index.ts'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

/** Start a pending tool call; release the answerer before disposing the host.
 * @returns Real host, paused Agent and observed window revision.
 */
export async function approvalHost() {
  const f = await admissionHost()
  const entered = Promise.withResolvers<undefined>()
  const approval = Promise.withResolvers<ApprovalOutcome>()
  try {
    f.ctx.loader.builtins.tools = Tools
    await f.load('approval-tools.yml', [{ name: 'cordis:tools', config: {} }])
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill', operationId: operation('approval-open') })
    if (opened.status !== 'prefilled') throw new Error('Window was not prefilled')
    const agent = f.ctx.agents.get(opened.sessionId)!
    f.ctx.on('tools/pre-execute', async (_execution, _next) => ({ kind: 'ask' as const }))
    f.ctx.on('approval/request', () => { entered.resolve(undefined); return approval.promise })
    f.adapter.stream = async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('pending-close'), name: 'seat_windows', arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'List the seat windows.' }], source: { kind: 'user' } }))
    await entered.promise
    await f.ctx.sessions.flush(agent.session)
    const listed = await f.seats.list({})
    if (listed.status !== 'listed') throw new Error('Windows unavailable')
    const window = listed.sessions.find(item => item.sessionId === opened.sessionId)!
    return { ...f, agent, window, async close() { approval.resolve('cancelled'); await f.close() } }
  } catch (error) {
    approval.resolve('cancelled')
    await f.close()
    throw error
  }
}
