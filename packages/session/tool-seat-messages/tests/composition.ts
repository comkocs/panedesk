/** Loader composition with production loops and mailboxes; only model output and seat observations are synthetic. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import AgentRegistry from '@panedesk/dsh-agent'
import AgentLoop from '@panedesk/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk, ToolCallId } from '@panedesk/dsh-llm'
import SessionStore, { SessionId } from '@panedesk/dsh-session'
import Projections from '@panedesk/dsh-session-projection'
import SystemPrompt from '@panedesk/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@panedesk/dsh-tools'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import Delivery from '@panedesk/dsh-message-delivery-local'
import Ledger from '@panedesk/dsh-session-ledger/messages'
import type { SeatLocalReadAccess, SeatMessageWindow } from '@panedesk/dsh-seat'
import * as SeatMessages from '../src/index.ts'

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const first = !this.requests.some(request => request.sessionId === options.sessionId)
    this.requests.push(options)
    if (options.sessionId === 'busy' && first) {
      const id = ToolCallId('long-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'long_tool', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'long_tool', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Received' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Received' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

export async function composition(seatAddressing?: boolean, options?: { nodeId: string; directory: string }) {
  const nodeId = options?.nodeId ?? 'node-a'
  const home = await mkdtemp(join(options?.directory ?? tmpdir(), 'seat-messages-'))
  const ctx = new Context()
  const windows: SeatMessageWindow[] = ['sender', 'busy', 'idle'].map(name => ({ seat: name,
    sessionId: SessionId(name), nodeId: nodeId as SeatMessageWindow['nodeId'], primary: true }))
  const read: SeatLocalReadAccess = {
    definitions: async () => ({ definitions: [], revision: 0, complete: true }),
    list: async () => ({ status: 'listed', sessions: [], unopenedSeats: [], complete: true, snapshotAt: new Date().toISOString() }),
    binding: async () => null,
    messageWindows: async () => windows,
  }
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  try {
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, sessions: SessionStore, agents: AgentRegistry,
      projections: Projections, prompt: SystemPrompt, tools: Tools, llm: LlmRuntime, loop: AgentLoop,
      persistence: Persistence, delivery: Delivery, ledger: Ledger, messages: SeatMessages,
      seats: { name: 'test-seats', apply(child: Context) { child.provide('seatLocalRead', read) } } })
    const path = join(home, 'cordis.yml')
    await writeFile(path, JSON.stringify([
      ...['sessions', 'projections', 'prompt', 'tools', 'llm', 'agents'].map(name => ({ name: `cordis:${name}` })),
      { name: 'cordis:persistence', config: { root: join(home, 'sessions'), compression: 'none' } },
      { name: 'cordis:ledger', config: { dshHome: home } }, { name: 'cordis:seats' },
      { name: 'cordis:delivery', config: { dshHome: home, nodeId, maxRecordBytes: 1048576,
        maxContentBytes: 4096, maxBatchSize: 100, lockTimeoutMs: 5000, lockRetryMs: 1, scanIntervalMs: 100,
        watch: false, ...(seatAddressing === undefined ? {} : { seatAddressing }) } },
      { name: 'cordis:loop', config: { agents: [] } }, { name: 'cordis:messages' },
    ]))
    ctx.baseUrl = `${pathToFileURL(home).href}/`
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'long_tool', description: 'Hold one tool boundary', parameters: {},
      async execute() { entered.resolve(undefined); await release.promise; return [{ type: 'text', text: 'Released' }] } }))
    const sender = await ctx.agentLoop.create(SessionId('sender'), { provider: 'mock', model: 'test' })
    const busy = await ctx.agentLoop.create(SessionId('busy'), { provider: 'mock', model: 'test' })
    const idleHandle = await ctx.agents.create({ sessionId: SessionId('idle'), agentOptions: { provider: 'mock', model: 'test' } })
    const idle = idleHandle.agent
    let calls = 0
    return { ctx, sender, busy, idle, idleHandle, adapter, read, windows, entered, release,
      execute: (name: string, args: unknown, callId = ToolCallId(`send-${++calls}`)) => ctx.agents.withInitiator(sender, () => ctx.tools.execute({
        name, arguments: args, agent: sender, callId, signal: new AbortController().signal,
      })),
      async close() { release.resolve(undefined); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) },
    }
  } catch (error) {
    release.resolve(undefined); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); throw error
  }
}
