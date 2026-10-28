import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Context } from '@panedesk/cordis'
import { JournalSessionLedger, type LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { applyEntryPatches } from '@panedesk/cordis-plugin-include'
import { boot, loadOverlayPatches } from '@panedesk/dsh-app-boot'
import { provideCmdline } from '@panedesk/dsh-cmdline'
import { createUserMessage, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { randomUUID } from 'node:crypto'
import { MessageId } from '@panedesk/dsh-llm/brand'
import { client as createAcpClientApp, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import * as Acp from '@panedesk/dsh-acp'
import { deployment, operation } from '../../../seat/seat-app/tests/fixtures/e2e-config.ts'
import { defineTool } from '@panedesk/dsh-tools'
import { startResponsesFixture } from '../../../subagent/subagent-codex/tests/responses-fixture.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const bundleRoot = fileURLToPath(new URL('../../../bundle/', import.meta.url))
const calls: string[] = []

class AccountingAdapter extends MockAdapter {
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'ledger-model', name: 'Ledger model' }])
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      yield* textResponse('Accounting fixture title')
      return
    }
    yield* super.stream(options)
  }
}

function expectConversationCalls(snapshot: LedgerSnapshot, requests: readonly Pick<GenerateOptions, 'sessionId' | 'purpose'>[], sessionId: SessionId): void {
  const received = requests.filter(request => request.sessionId === sessionId && request.purpose === undefined)
  const rows = snapshot.rows.filter(row => row.kind === 'call')
    .filter(row => row.start.purpose === 'conversation' && row.start.sessionId === sessionId)
  expect(received).toHaveLength(2)
  expect(rows).toHaveLength(received.length)
  expect(new Set(rows.map(row => row.start.callId)).size).toBe(received.length)
}

async function start(profile: 'slim' | 'full'): Promise<{ ctx: Context; adapter: AccountingAdapter }> {
  const home = await mkdtemp(join(tmpdir(), 'default-ledger-'))
  roots.push(home)
  vi.stubEnv('PANEDESK_HOME', home)
  const layers = profile === 'slim' ? ['slim-base', 'slim-headless'] : ['base', 'headless']
  const warnings: string[] = []
  const entries = applyEntryPatches([], layers.flatMap(layer => loadOverlayPatches('default-ledger-test', join(bundleRoot, layer, 'cordis.patch.yml'))), line => warnings.push(line))
  expect(warnings).toEqual([])
  const modules = new Map<string, object>()
  for (const entry of entries) {
    // The Loader still mounts every shipped row; Vite supplies its source module rather than built artifacts.
    if (!modules.has(entry.name)) modules.set(entry.name, await import(entry.name) as object)
    const id = `fixture-${modules.size}-${entry.id}`
    modules.set(id, modules.get(entry.name)!)
    entry.name = `cordis:${id}`
    if (entry.id === 'agent-default-model') entry.config = { provider: 'mock', model: 'ledger-model' }
  }
  const path = join(home, 'cordis.yml')
  await writeFile(path, JSON.stringify(entries))
  const ctx = await boot('default-ledger-test', path, undefined, (host) => {
    host.provide('profileContext', { name: profile, home, cwd: home, dir: home,
      patchPath: join(home, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
      startedBundles: layers.map(layer => layer === 'base' ? '@panedesk/dsh-base' : `@panedesk/${layer}`),
      overlays: [], telemetryDisabledEnv: '1' })
    provideCmdline(host, { args: [], exit: () => {}, ready: { onReady: () => () => {} } })
    for (const [name, module] of modules) host.loader.builtins[name] = module
  })
  contexts.push(ctx)
  const adapter = new AccountingAdapter([
    toolCallResponse('main-call', 'ledger_probe', { text: 'main' }), textResponse('main done'),
    toolCallResponse('child-call', 'ledger_probe', { text: 'child' }), textResponse('child done'),
    toolCallResponse('acp-call', 'ledger_probe', { text: 'acp' }), textResponse('acp done'),
    toolCallResponse('seat-call', 'ledger_probe', { text: 'seat' }), textResponse('seat done'),
  ], { efforts: [{ id: ReasoningEffortId('effort-a'), name: 'Fixture effort' }] })
  ctx.effect(() => ctx.get('llm')!.registerAdapter(['mock'], adapter))
  ctx.effect(() => ctx.get('tools')!.register(defineTool({
    name: 'ledger_probe', description: 'Record one deterministic test tool call.',
    parameters: { text: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { calls.push(args.text ?? ''); return args.text ?? '' },
  })))
  return { ctx, adapter }
}

describe('default profile durable accounting', () => {
  it.each(['slim', 'full'] as const)('%s records main, managed, ACP, seat and SDK tool turns with run starts and physical calls', async (profile) => {
    calls.length = 0
    const { ctx, adapter } = await start(profile)
    expect(ctx.get('sessionLedger')).toBeDefined()
    expect(ctx.get('messageLedger')).toBeDefined()
    expect(ctx.get('llmCache')).toBeDefined()
    const fallback = vi.spyOn(ctx.get('sessionLedger')!, 'messages').mockRejectedValue(new Error('Full-ledger messages fallback must not run'))
    const handle = await ctx.get('agents')!.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'mock', model: 'ledger-model' } })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the probe.' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      expect(calls).toEqual(['main'])
      const activation = await ctx.get('subagents')!.startActivation({ provider: 'spawn', label: 'child',
        request: { prompt: [{ type: 'text', text: 'Run the probe.' }], parent: handle.agent },
        signal: new AbortController().signal, delivery: 'caller' })
      await activation.result
      expect(calls).toEqual(['main', 'child'])
      for (const sessionId of [handle.agent.id, activation.childId]) {
        const snapshot = await ctx.get('sessionLedger')!.snapshot({ sessionId })
        expect(snapshot.complete).toBe(true)
        expect(snapshot.rows.some(row => row.kind === 'run')).toBe(true)
        expect(snapshot.rows.filter(row => row.kind === 'call' && row.start.purpose === 'conversation')).toHaveLength(2)
        expectConversationCalls(snapshot, adapter.requests, sessionId)
        expect(snapshot.rows.some(row => row.kind === 'event' && row.event.kind === 'wait/start')).toBe(true)
      }
      const messageRead = vi.spyOn(ctx.get('messageLedger')!, 'read')
      await expect(ctx.get('messageDelivery')!.status(MessageId('nonexistent-probe'))).rejects.toThrow()
      expect(messageRead).toHaveBeenCalled()
      expect(fallback).not.toHaveBeenCalled()
      messageRead.mockRestore()

      const outbound = new TransformStream<Uint8Array, Uint8Array>()
      const inbound = new TransformStream<Uint8Array, Uint8Array>()
      const clientApp = createAcpClientApp({ name: 'default-accounting-test' })
        .onNotification(methods.client.session.update, () => {})
        .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: 'cancelled' } }))
      ctx.loader.builtins['accounting-acp'] = { ...Acp,
        apply: (host: Context, config: Acp.AcpConfig) => {
          Acp.apply(host, { ...config, stream: ndJsonStream(outbound.writable, inbound.readable) })
        } }
      const acpId = await ctx.loader.create({ name: 'cordis:accounting-acp',
        config: { provider: 'mock', model: 'ledger-model' } })
      await ctx.loader.await()
      const client = clientApp.connect(ndJsonStream(inbound.writable, outbound.readable)).agent
      try {
        await client.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
        const session = await client.request(methods.agent.session.new, { cwd: ctx.get('profileContext')!.home, mcpServers: [] })
        const response = await client.request(methods.agent.session.prompt, { sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Run the probe.' }] })
        expect(response.stopReason).toBe('end_turn')
        expect(calls).toEqual(['main', 'child', 'acp'])
        const snapshot = await ctx.get('sessionLedger')!.snapshot({ sessionId: SessionId(session.sessionId) })
        expect(snapshot.rows.some(row => row.kind === 'run')).toBe(true)
        expect(snapshot.rows.filter(row => row.kind === 'call' && row.start.purpose === 'conversation')).toHaveLength(2)
        expectConversationCalls(snapshot, adapter.requests, SessionId(session.sessionId))
      } finally { await ctx.loader.resolve(acpId).fiber?.dispose() }

      const home = ctx.get('profileContext')!.home
      const seatConfig = deployment(home, await ctx.get('sessionLedger')!.nodeId())
      seatConfig.definition.provider = 'mock'
      seatConfig.definition.model = 'ledger-model'
      seatConfig.definition.permissionPreset = 'workspace-write'
      const credentialModule: object = await import('@panedesk/dsh-credentials-local')
      ctx.loader.builtins['seat-credentials'] = credentialModule
      await ctx.loader.create({ name: 'cordis:seat-credentials', config: { dshHome: home, watch: false } })
      const dependencyRows = [
        ['commands', '@panedesk/dsh-commands', {}],
        ['session-title', '@panedesk/dsh-session-title', { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }],
        ['storage', '@panedesk/dsh-storage', {}],
        ['storage-json', '@panedesk/dsh-storage-json', { root: join(home, 'storages') }],
        ['storage-domain', '@panedesk/dsh-storage-domain', { backend: 'json' }],
        ['typert', '@panedesk/dsh-typert-registry', {}],
        ['remote-access', '@panedesk/dsh-api-remote-access', {}],
        ['attachment-local', '@panedesk/dsh-attachment-local', { dshHome: home }],
        ['session-query-sqlite', '@panedesk/dsh-session-query-sqlite', { path: ':memory:', openAt: 'never' }],
        ['workspace', '@panedesk/dsh-workspace', {}],
        ['connection', '@panedesk/dsh-client-connection', {}],
        ['file-upload', '@panedesk/dsh-client-file-upload', {}],
        ['session-controller', '@panedesk/dsh-api-session-controller', { nativeOpen: false }],
        ['seat-engine', '@panedesk/dsh-seat-engine', seatConfig.engine],
        ['seat-local', '@panedesk/dsh-seat-local', seatConfig.local],
      ] as const
      const loaded = new Set([...ctx.loader.entries()].map(entry => entry.options.id))
      for (const [id, module, config] of dependencyRows) {
        if (loaded.has(id)) continue
        const builtin = `seat-fixture-${id}`
        ctx.loader.builtins[builtin] = await import(module) as object
        await ctx.loader.create({ name: `cordis:${builtin}`, config })
      }
      await ctx.loader.await()
      await vi.waitFor(() => {
        const pending = [...ctx.loader.entries()].filter(entry => !entry.disabled)
          .map(entry => ({ id: entry.options.id,
            missing: Object.keys(entry.fiber?.inject ?? {}).filter(name => ctx.get(name) === undefined) }))
          .filter(entry => entry.missing.length > 0)
        expect(ctx.get('seats'), JSON.stringify(pending)).toBeDefined()
        expect(ctx.get('sessionCreation'), JSON.stringify(pending)).toBeDefined()
      })
      await ctx.get('seatEngine')!.ready()
      const seats = ctx.get('seats')!.withAuthority({ principalId: 'test-user' as import('@panedesk/dsh-seat').SeatPrincipalId,
        origin: 'manual', nodeId: seatConfig.local.nodeId })
      const sourcePath = join(home, 'seats.csv')
      await writeFile(sourcePath, 'seat,model\nseat-a,ledger-model\n')
      const plan = await seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} })
      if ('status' in plan) throw new Error(JSON.stringify(plan))
      expect(plan.rows[0]?.diagnostics).toEqual([])
      expect(await seats.commitImport({ planId: plan.planId, selectedRows: [plan.rows[0]!.row],
        expectedRevision: 0, operationId: operation('import-ledger') })).toMatchObject({ status: 'committed' })
      const opened = await seats.open({ seat: seatConfig.definition.seat, origin: 'manual', operationId: operation('open-ledger') })
      if (opened.status !== 'opened') throw new Error(JSON.stringify(opened))
      await vi.waitFor(() => { expect(calls).toContain('seat') })
      await ctx.get('agents')!.get(opened.sessionId)!.whenIdle()
      const seatLedger = await ctx.get('sessionLedger')!.snapshot({ sessionId: opened.sessionId })
      expect(seatLedger.rows.some(row => row.kind === 'run')).toBe(true)
      expect(seatLedger.rows.filter(row => row.kind === 'call' && row.start.purpose === 'conversation')).toHaveLength(2)
      expectConversationCalls(seatLedger, adapter.requests, opened.sessionId)

      const childHome = join(home, 'sdk-child')
      const marker = join(home, 'sdk-tool-executed')
      const sdkPatch = join(home, 'sdk.patch.yml')
      await writeFile(sdkPatch, JSON.stringify([
        { id: 'agent-default-model', config: { provider: 'mock', model: 'ledger-model' } },
        { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
        { id: 'session-title-llm', disabled: true },
        { insert: [
          { id: 'sdk-app-startup', name: '@panedesk/dsh-sdk-app', config: { profile } },
          { id: 'sdk-jsonrpc-server', name: '@panedesk/dsh-sdk-jsonrpc-server', inject: ['sdkAppStartup', 'loader'] },
          { id: 'accounting-fixture', name: fileURLToPath(new URL('./fixtures/default-accounting.ts', import.meta.url)) },
        ] },
      ]))
      ctx.loader.builtins['accounting-sdk'] = await import('@panedesk/dsh-subagent-dsh-sdk')
      await ctx.loader.create({ name: 'cordis:accounting-sdk', config: {
        profile, patches: [sdkPatch], dshHome: childHome, provider: 'mock', model: 'ledger-model',
        env: { DSH_ACCOUNTING_MARKER: marker, PANEDESK_TELEMETRY_DISABLED: '1' },
      } })
      await ctx.loader.await()
      const sdk = await ctx.get('subagents')!.startActivation({ provider: 'dsh-sdk', label: 'sdk accounting',
        request: { prompt: [{ type: 'text', text: 'Run the probe.' }], parent: handle.agent },
        signal: new AbortController().signal, delivery: 'caller' })
      try {
        expect((await sdk.result).stopReason).toBe('completed')
        expect(await readFile(`${marker}.result`, 'utf8')).not.toContain('"isError":true')
        expect(await readFile(marker, 'utf8')).toBe('executed\n')
      } finally { await sdk.dispose() }
      const childReader = new Context()
      contexts.push(childReader)
      const childLedger = new JournalSessionLedger(childReader, { dshHome: childHome })
      const sdkLedger = await childLedger.snapshot()
      expect(sdkLedger.complete).toBe(true)
      const sdkCalls = sdkLedger.rows.filter(row => row.kind === 'call' && row.start.purpose === 'conversation')
      expect(sdkCalls).toHaveLength(2)
      const sdkRequests = (await readFile(`${marker}.requests`, 'utf8')).trim().split('\n').map((line) => {
        const request: unknown = JSON.parse(line)
        if (request === null || typeof request !== 'object' || !('sessionId' in request)
          || typeof request.sessionId !== 'string' || 'purpose' in request) throw new Error('Invalid SDK conversation request marker')
        return { sessionId: SessionId(request.sessionId) }
      })
      expect(new Set(sdkRequests.map(request => request.sessionId)).size).toBe(1)
      expectConversationCalls(sdkLedger, sdkRequests, sdkRequests[0]!.sessionId)
      for (const row of sdkCalls) {
        if (row.kind !== 'call') continue
        expect(sdkLedger.rows.some(run => run.kind === 'run' && run.start.runId === row.start.runId)).toBe(true)
      }
      expect(sdkLedger.rows.some(row => row.kind === 'event' && row.event.kind === 'wait/start')).toBe(true)

      const codexHome = join(home, 'codex-home')
      await mkdir(codexHome)
      const externalMarker = join(home, 'external-tool-executed')
      const command = `printf executed > ${JSON.stringify(externalMarker)}`
      const fixture = await startResponsesFixture([
        { kind: 'advertisedFunctionCall', choices: [
          { name: 'exec_command', arguments: { cmd: command } },
          { name: 'shell_command', arguments: { command } },
        ] },
        { kind: 'complete', text: 'External accounting complete' },
      ])
      try {
        await writeFile(join(codexHome, 'config.toml'), [
          'model = "fixture-model"', 'model_provider = "fixture"', 'disable_response_storage = true',
          'check_for_update_on_startup = false', '[model_providers.fixture]', 'name = "Fixture Responses"',
          `base_url = "${fixture.baseUrl}"`, 'wire_api = "responses"', 'requires_openai_auth = false',
          '[analytics]', 'enabled = false',
        ].join('\n'))
        ctx.loader.builtins['accounting-codex'] = await import('@panedesk/dsh-subagent-codex')
        await ctx.loader.create({ name: 'cordis:accounting-codex', config: {
          permissionMode: 'dangerously-bypass-approvals-and-sandbox', disposeGraceMs: 2000,
          env: { CODEX_HOME: codexHome, HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'),
            HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: 'localhost' },
        } })
        await ctx.loader.await()
        const external = await ctx.get('subagents')!.startActivation({ provider: 'codex', label: 'external accounting',
          request: { prompt: [{ type: 'text', text: 'Run the isolated marker command.' }], parent: handle.agent },
          signal: new AbortController().signal, delivery: 'caller' })
        try {
          expect((await external.result).stopReason).toBe('completed')
          expect(await readFile(externalMarker, 'utf8')).toBe('executed')
          const snapshot = await ctx.get('sessionLedger')!.snapshot({ sessionId: external.childId })
          expect(snapshot.rows.some(row => row.kind === 'run')).toBe(true)
          expect(snapshot.rows.filter(row => row.kind === 'call')).toHaveLength(0)
          // External transports bypass llm/stream; aggregate run usage is not a physical call row.
          expect(fixture.requests).toHaveLength(2)
          expect(adapter.requests.filter(request => request.sessionId === external.childId)).toHaveLength(0)
        } finally { await external.dispose() }
      } finally { await fixture.close() }
    } finally { fallback.mockRestore(); await handle.dispose() }
  }, 30000)
})
