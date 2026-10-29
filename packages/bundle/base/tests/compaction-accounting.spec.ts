/** Real Loader composition keeps compaction facts separate from physical model calls. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import AgentRegistry from '@panedesk/dsh-agent'
import AgentLoop from '@panedesk/dsh-agent-loop'
import SessionStore, { SessionId } from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SystemPrompt from '@panedesk/dsh-system-prompt'
import ToolRuntime from '@panedesk/dsh-tools'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@panedesk/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@panedesk/dsh-llm'
import JournalSessionLedger from '@panedesk/dsh-session-ledger'
import LedgerQuery from '@panedesk/dsh-ledger-query'
import * as Cache from '@panedesk/dsh-llm-cache'
import * as CompactionLedger from '@panedesk/dsh-compaction-ledger'
import BasicCompactionEngine from '@panedesk/dsh-compaction-basic'
import TokenMeter from '@panedesk/dsh-token-meter'

class TextAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Deterministic summary.' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Reproduces the old assembly: the checkpoint writer has no ownership registration. */
class LegacyRegistrationLedger extends JournalSessionLedger {
  private readonly checkpointWritten = Promise.withResolvers<undefined>()
  override registerCompactionOwner(): () => void { return () => {} }
  override async appendEvent(event: Parameters<JournalSessionLedger['appendEvent']>[0]) {
    // Fix the historical M4-first ordering while retaining real journal conflict handling.
    if (event.kind === 'compaction' && event.callId !== undefined) await this.checkpointWritten.promise
    const result = await super.appendEvent(event)
    if (event.kind === 'compaction' && event.callId === undefined) this.checkpointWritten.resolve(undefined)
    return result
  }
}

async function load(root: string, withOwner: boolean, legacy = false) {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, llm: LlmRuntime, sessions: SessionStore,
    projections: SessionProjectionRegistry, prompt: SystemPrompt, tools: ToolRuntime, agents: AgentRegistry,
    loop: AgentLoop, ledger: legacy ? LegacyRegistrationLedger : JournalSessionLedger,
    cache: Cache, checkpoint: CompactionLedger,
    compaction: BasicCompactionEngine, meter: TokenMeter })
  const entries = ['llm', 'sessions', 'projections', 'prompt', 'tools', 'agents'].map(name => ({ name: `cordis:${name}` }))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...entries,
    { name: 'cordis:loop', config: { agents: [] } },
    { name: 'cordis:ledger', config: { dshHome: root } },
    { name: 'cordis:cache', config: {} },
    { name: 'cordis:meter' },
    ...withOwner ? [{ name: 'cordis:checkpoint', config: { maxTokens: 8000, recentEventLimit: 0 } }] : [],
    { name: 'cordis:compaction', config: { auto: false } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const adapter = new TextAdapter()
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], adapter))
  const warnings = vi.spyOn(ctx.logger, 'warn')
  return { ctx, adapter, warnings }
}

it.each([true, false])('records one fact per slot and one row per request across two compactions (checkpoint owner: %s)', async (withOwner) => {
  const root = await mkdtemp(join(import.meta.dirname, '.compaction-accounting-'))
  const h = await load(root, withOwner)
  try {
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId('compaction-accounting'),
      agentOptions: { provider: 'fixture', model: 'text' } })
    const followup = async () => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Conversation history. '.repeat(3000) }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const ending = agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)
      if (ending?.data.reason.kind === 'error') throw new Error(ending.data.reason.error.message)
    }
    await followup()
    expect(h.adapter.requests).toHaveLength(1)
    const slots: number[] = []
    for (let pass = 1; pass <= 2; pass++) {
      const result = await h.ctx.compaction.compactNow(agent, new AbortController().signal)
      expect(result).not.toBeNull()
      slots.push(result!.summarySeq)
      await followup()
      expect(h.adapter.requests).toHaveLength(1 + pass * 2)
      const snapshot = await h.ctx.sessionLedger.snapshot({ sessionId: agent.id })
      const calls = snapshot.rows.filter(row => row.kind === 'call')
      const facts = snapshot.rows.flatMap(row => row.kind === 'event' && row.event.kind === 'compaction' ? [row.event] : [])
      expect(facts).toHaveLength(pass)
      for (const slot of slots) expect(facts.filter(event => event.committedSeq === slot)).toHaveLength(1)
      for (const fact of facts) {
        if (withOwner) {
          expect(fact.eventId).toBe(`compaction:${agent.id}:${fact.committedSeq}`)
          expect(fact.peakContextUsageTokens).toBe(30)
          expect(fact.peakContextEstimatedTokens).toBeGreaterThan(0)
          expect(fact.callId).toBeUndefined()
        } else {
          expect(fact.callId).toBeDefined()
          expect(fact.peakContextUsageTokens).toBeUndefined()
        }
      }
      expect(calls).toHaveLength(h.adapter.requests.length)
      expect(new Set(calls.map(row => row.start.callId)).size).toBe(calls.length)
      expect(calls.every(row => row.finish?.endReason === 'completed')).toBe(true)
      expect(calls.filter(row => row.start.purpose === 'compaction')).toHaveLength(pass)
      expect(h.warnings.mock.calls.flat().join(' ')).not.toMatch(/repair|blocked|failed/i)
      console.log(JSON.stringify({ withOwner, pass, requests: h.adapter.requests.length,
        compactionSlots: slots.length, eventsPerSlot: slots.map(slot => facts.filter(event => event.committedSeq === slot).length),
        callRows: calls.length, rowsPerRequest: 1, repairWarnings: 0 }))
    }
  } finally {
    await h.ctx.fiber.dispose()
    h.warnings.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('reopens a ledger after the legacy duplicate blocked calls without changing its exported facts', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.compaction-recovery-'))
  const old = await load(root, true, true)
  let next: Awaited<ReturnType<typeof load>> | undefined
  try {
    const sessionId = SessionId('legacy-compaction')
    const { agent } = await old.ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'text' } })
    const followup = async () => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Legacy history. '.repeat(3000) }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    await followup()
    await old.ctx.compaction.compactNow(agent, new AbortController().signal)
    await followup()
    expect(old.adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason).toMatchObject({
      kind: 'error', error: { message: 'Cache accounting requires repair: Ledger rejected conflicting call evidence' },
    })
    expect(old.warnings.mock.calls.flat().join(' ')).toContain('further calls are blocked')
    const seed = structuredClone(agent.session.snapshotEvents())
    await old.ctx.fiber.dispose()
    old.warnings.mockRestore()
    const reader = new Context()
    const beforePath = join(root, 'before.jsonl')
    try {
      await reader.plugin(LegacyRegistrationLedger, { dshHome: root })
      await reader.plugin(LedgerQuery)
      await reader.ledgerQuery.export({ query: { sessionId }, format: 'jsonl', outputPath: beforePath })
    } finally { await reader.fiber.dispose() }
    const exported = (await readFile(beforePath, 'utf8')).split('\n').slice(1)
    next = await load(root, true)
    await next.ctx.plugin(LedgerQuery)
    const afterPath = join(root, 'after.jsonl')
    await next.ctx.ledgerQuery.export({ query: { sessionId }, format: 'jsonl', outputPath: afterPath })
    expect((await readFile(afterPath, 'utf8')).split('\n').slice(1)).toEqual(exported)
    const handle = await next.ctx.agents.create({ sessionId, seed, agentOptions: { provider: 'fixture', model: 'text' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after reopening.' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(next.adapter.requests).toHaveLength(1)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' })
    const after = await next.ctx.sessionLedger.snapshot({ sessionId })
    expect(after.rows.filter(row => row.kind === 'event' && row.event.kind === 'compaction')).toHaveLength(1)
    expect(after.rows.filter(row => row.kind === 'call')).toHaveLength(3)
    expect(next.warnings.mock.calls.flat().join(' ')).not.toMatch(/repair|blocked|failed/i)
  } finally {
    await old.ctx.fiber.dispose()
    old.warnings.mockRestore()
    await next?.ctx.fiber.dispose()
    next?.warnings.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('rejects concurrent owners and restores fallback accounting when the checkpoint plugin unloads', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.compaction-owner-'))
  const h = await load(root, true)
  try {
    const ledger = h.ctx.sessionLedger
    expect(() => ledger.registerCompactionOwner()).toThrow('already registered')
    const entry = [...h.ctx.loader.entries()].find(item => item.options.name === 'cordis:checkpoint')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    const release = ledger.registerCompactionOwner()
    expect(() => ledger.registerCompactionOwner()).toThrow('already registered')
    release()
    release()
    const replacement = ledger.registerCompactionOwner()
    release()
    expect(() => ledger.registerCompactionOwner()).toThrow('already registered')
    replacement()
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId('released-owner'),
      agentOptions: { provider: 'fixture', model: 'text' } })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'History. '.repeat(3000) }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await h.ctx.compaction.compactNow(agent, new AbortController().signal)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const facts = (await ledger.snapshot({ sessionId: agent.id })).rows
      .flatMap(row => row.kind === 'event' && row.event.kind === 'compaction' ? [row.event] : [])
    expect(facts).toHaveLength(1)
    expect(facts[0]?.callId).toBeDefined()
    expect(h.adapter.requests).toHaveLength(3)
  } finally {
    await h.ctx.fiber.dispose()
    h.warnings.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
