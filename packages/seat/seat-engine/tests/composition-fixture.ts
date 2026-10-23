/** Loader composition owns real AgentLoop, message delivery, journal and Session persistence. */
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import AgentRegistry from '@panedesk/dsh-agent'
import AgentLoop from '@panedesk/dsh-agent-loop'
import LlmRuntime from '@panedesk/dsh-llm'
import SessionStore from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SystemPrompt from '@panedesk/dsh-system-prompt'
import ToolRuntime from '@panedesk/dsh-tools'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import * as Cache from '@panedesk/dsh-llm-cache'
import JournalSessionLedger from '@panedesk/dsh-session-ledger'
import LocalMessageDelivery from '@panedesk/dsh-message-delivery-local'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as EnginePlugin from '../src/index.ts'
import { config } from './fixtures.ts'
import { CompositionSeats, BarrierAdapter } from './composition-provider.ts'

/** Boot a private test-only YAML profile; release persistence after its live owners. */
export async function composition(cache = false, additions: {
  builtins?: Record<string, unknown>
  entries?: { name: string; config?: object }[]
  sources?: EnginePlugin.Config['sources']
} = {}) {
  const home = await mkdtemp(join(process.cwd(), 'packages/seat/seat-engine/tests', '.composition-'))
  const ctx = new Context()
  try {
    ctx.baseUrl = `${pathToFileURL(home).href}/`
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, agents: AgentRegistry, loop: AgentLoop, llm: LlmRuntime,
      session: SessionStore, projections: SessionProjectionRegistry, prompt: SystemPrompt, tools: ToolRuntime,
      persistence: Persistence, ledger: JournalSessionLedger, delivery: LocalMessageDelivery,
      seats: CompositionSeats, engine: EnginePlugin, cache: Cache, ...additions.builtins })
    const entries = [
      { name: 'cordis:llm' }, { name: 'cordis:session' }, { name: 'cordis:projections' },
      { name: 'cordis:prompt', config: {} }, { name: 'cordis:tools', config: {} }, { name: 'cordis:agents' },
      { name: 'cordis:persistence', config: { root: join(home, 'sessions'), compression: 'none' } },
      { name: 'cordis:ledger', config: { dshHome: home } },
      { name: 'cordis:loop', config: { agents: [] } },
      { name: 'cordis:delivery', config: { dshHome: home, maxRecordBytes: 1048576, maxContentBytes: 4096,
        maxBatchSize: 100, lockTimeoutMs: 5000, lockRetryMs: 1, scanIntervalMs: 100, watch: false } },
      { name: 'cordis:seats' },
      ...(additions.entries ?? []),
      ...(cache ? [{ name: 'cordis:cache', config: { policy: { retention: 'default' },
        keepalive: { enabled: false, leadSeconds: 240, minimumIntervalSeconds: 60, maxOutputTokens: 1 },
        concurrency: [{ modelFamily: 'mock', maxInFlight: 1 }],
        routes: [{ provider: 'mock', modelFamily: 'mock', capability: 'anthropic' }] } }] : []),
    ]
    const profile = join(home, 'cordis.yml')
    await writeFile(profile, JSON.stringify(entries))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
    await ctx.loader.await()
    const nodeId = await ctx.sessionLedger.nodeId()
    const engineProfile = join(home, 'engine.yml')
    await writeFile(engineProfile, JSON.stringify([{ name: 'cordis:engine',
      config: { ...config, home, nodeAliases: { local: nodeId }, sources: additions.sources } }]))
    const engineEntry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(engineProfile).href } })
    await ctx.loader.await()
    const adapter = new BarrierAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    return { ctx, adapter, home, async close() {
      adapter.finish()
      for (const agent of ctx.agents.list()) await agent.whenIdle()
      await ctx.loader.resolve(engineEntry).fiber?.dispose()
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    } }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
    throw error
  }
}
