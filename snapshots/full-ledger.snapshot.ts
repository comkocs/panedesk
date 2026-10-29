/** Unordered upstream event parity and durable accounting with the full ledger enabled. */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@panedesk/cordis'
import { JournalSessionLedger } from '@panedesk/dsh-session-ledger'
import { DeepSeekHarness } from '@panedesk/dsh-sdk-client'
import { runLoaderSmoke } from '@panedesk/dsh-loader-smoke'
import { parseSessionLog } from '@panedesk/dsh-llm-replay'
import type {} from '@panedesk/dsh-session-title-llm'
import {
  fixtureContext, latestPersistedSessionPaths, materializeProfilePatch,
  normalizeSessionSnapshots, sessionFixtureNames,
} from '@panedesk/dsh-session-snapshot'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const base = join(root, 'snapshots/session/text-turn')

// Ledger facts live in a separate journal and are not upstream Session events.
const excludedLedgerEvents = {
  'call/start': 'Physical dispatch intent is checked against the replayed model requests separately.',
  'call/end': 'Physical settlement is checked on its single projected call row separately.',
  'run/start': 'Durable residency is checked for every executed tool separately.',
  'run/end': 'Residency settlement has no corresponding upstream Session event.',
  'wait/start': 'Tool wait attribution is checked against each durable run separately.',
  'wait/end': 'Tool wait duration is ledger-only timing evidence.',
  'process/observed': 'Local process liveness is ledger-only evidence.',
  'turn/start': 'Durable writes can deliver a child settlement notice within the current parent turn.',
  'turn/end': 'A settlement notice may finish in the current parent turn instead of a new turn.',
} as const

interface Scenario {
  readonly name: string
  readonly profile: 'sdk' | 'headless'
  readonly composition: string
  readonly timeoutMs: number
}

const scenarios: readonly Scenario[] = [
  { name: 'session-title-stability', profile: 'sdk', composition: 'session-title-stability', timeoutMs: 120_000 },
  { name: 'subagent-spawn-in-process', profile: 'headless', composition: 'text-turn', timeoutMs: 30_000 },
  { name: 'background-job-admission', profile: 'headless', composition: 'background-job-admission', timeoutMs: 30_000 },
]

async function persisted(home: string): Promise<string[]> {
  const directory = join(home, 'sessions')
  const paths = latestPersistedSessionPaths(await readdir(directory, { recursive: true }))
  const logs = await Promise.all(paths.map(path => readFile(join(directory, path), 'utf8')))
  return logs.sort((left, right) => {
    const a = JSON.parse(left.split('\n')[0]!) as { parentSession?: string; createdAt: number }
    const b = JSON.parse(right.split('\n')[0]!) as { parentSession?: string; createdAt: number }
    return Number(a.parentSession !== undefined) - Number(b.parentSession !== undefined) || a.createdAt - b.createdAt
  })
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function eventBag(logs: readonly string[]): string[][] {
  const normalized = normalizeSessionSnapshots(logs, fixtureContext(logs[0]!), { nativeWriterOutput: true })
  return normalized.map(log => log.trim().split('\n').slice(1).flatMap((line) => {
    const event: { type: string } = JSON.parse(line)
    return Object.hasOwn(excludedLedgerEvents, event.type) ? [] : [canonical(event)]
  }).sort())
}

async function replay(scenario: Scenario, cwd: string, fixtures: readonly string[], files: readonly string[]): Promise<number> {
  const directory = join(root, 'snapshots', scenario.profile === 'sdk' ? 'sdk' : 'session', scenario.name)
  const composition = join(root, 'snapshots', scenario.profile === 'sdk' ? 'sdk' : 'session', scenario.composition)
  const parent = fixtures[0]!
  const events = parseSessionLog(parent)
  const sources = [join(base, 'cordis.yml'), join(composition, 'cordis.snapshot.yml'), join(base, 'model.cordis.yml')]
  const patchRoot = join(cwd, '.snapshot-patches')
  await mkdir(patchRoot)
  const patches = sources.map((source, index) => materializeProfilePatch(source, cwd, scenario.profile, patchRoot, index))
  const overlay = join(patchRoot, 'full-ledger.patch.yml')
  await writeFile(overlay, '- id: llm-cache\n  disabled: true\n- id: session-ledger-full\n  disabled: false\n')
  patches.push(overlay)
  const env = {
    DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_FILE: join(directory, files[0]!),
    DSH_SNAPSHOT_CHILD_FILES: files.slice(1).map(file => join(directory, file)).join(delimiter),
    DSH_SNAPSHOT_PROVIDER: 'deepseek-official', DSH_SNAPSHOT_MODEL: 'deepseek-v4-flash',
    ...(scenario.name === 'subagent-spawn-in-process' ? {} : { DSH_SNAPSHOT_OVERRIDE: join(directory, 'replay.override.json') }),
    PANEDESK_HOME: join(cwd, '.panedesk'), PANEDESK_AGENTS_HOME: join(cwd, '.agents'),
    PANEDESK_TELEMETRY_DISABLED: '1',
  }
  if (scenario.profile === 'headless') {
    const prompt = events.find(event => event.type === 'user/message' && event.data.source?.kind === 'user')
    if (prompt?.type !== 'user/message') throw new Error('Missing upstream user prompt')
    const task = prompt.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const started = performance.now()
    await runLoaderSmoke({ label: `${scenario.name} full ledger`, cwd, binScript: join(root, 'apps/cli/src/bin.ts'),
      configPath: overlay, tsconfigPath: join(root, 'tsconfig.json'), sourceImport: 'tsx/esm', env,
      processTimeoutMs: scenario.timeoutMs,
      binArgs: ['--profile', 'headless', ...patches.flatMap(path => ['--patch', path]), task] })
    return performance.now() - started
  }
  const harness = new DeepSeekHarness({ profile: 'sdk', patches, cwd, processCwd: cwd,
    dshHome: env.PANEDESK_HOME, env, provider: 'deepseek-official', model: 'deepseek-v4-flash',
    initializeTimeoutMs: 110_000, requestTimeoutMs: 110_000 })
  const started = performance.now()
  try {
    await harness.start()
    const session = harness.session('fixture-root-session')
    const titles = harness.client.subscribeSessionTree(session.id)
    try {
      const expectedTitles = events.filter(event => event.type === 'session/title' && event.data.source.kind === 'provider')
      const prompts = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user')
      for (const [index, prompt] of prompts.entries()) {
        if (prompt.type !== 'user/message') throw new Error('Expected upstream human message')
        const text = prompt.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        await session.run(text)
        const expected = expectedTitles[index]
        if (expected?.type !== 'session/title') throw new Error('Missing upstream provider title')
        for (;;) {
          const notification = await titles.next()
          if (notification.method !== 'session.event') continue
          const event = notification.params.event as { type: string; data: { title?: string; source?: { kind: string } } }
          if (event.type === 'session/title' && event.data.source?.kind === 'provider' && event.data.title === expected.data.title) break
        }
      }
    } finally { titles.close() }
  } finally { await harness.close() }
  return performance.now() - started
}

describe('full ledger upstream snapshot invariants', () => {
  for (const scenario of scenarios) {
    it(`${scenario.name} preserves every event once, physical calls, durable tool starts and upstream exit deadline`, async () => {
      const directory = join(root, 'snapshots', scenario.profile === 'sdk' ? 'sdk' : 'session', scenario.name)
      const files = sessionFixtureNames(await readdir(directory))
      const fixtures = await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))
      const cwd = await mkdtemp(join(tmpdir(), 'full-ledger-snapshot-'))
      const reader = new Context()
      try {
        const entries = await readdir(directory, { withFileTypes: true })
        if (entries.some(entry => entry.name === 'workspace' && entry.isDirectory())) {
          await cp(join(directory, 'workspace'), cwd, { recursive: true })
        }
        const elapsed = await replay(scenario, cwd, fixtures, files)
        expect(elapsed, 'clean subprocess exit stays within the unchanged upstream deadline').toBeLessThan(scenario.timeoutMs)
        const home = join(cwd, '.panedesk')
        const logs = await persisted(home)
        if (scenario.name === 'subagent-spawn-in-process') {
          const notices = parseSessionLog(logs[0]!).filter(event => event.type === 'user/message'
            && event.data.source?.kind === 'subagent-settled')
          expect(notices, 'child settlement reaches the parent exactly once in either turn arrangement').toHaveLength(1)
        }
        expect(eventBag(logs), 'all upstream normalized events occur with their exact multiplicity, without ordering').toEqual(eventBag(fixtures))
        const ledger = new JournalSessionLedger(reader, { dshHome: home })
        const snapshot = await ledger.snapshot()
        expect(snapshot.complete).toBe(true)
        const calls = snapshot.rows.filter(row => row.kind === 'call')
        for (const log of logs) {
          const sessionId = fixtureContext(log).sessionIds[0]
          const events = parseSessionLog(log)
          for (const purpose of ['conversation', 'session-title'] as const) {
            const requests = events.filter(event => purpose === 'conversation'
              ? event.type === 'assistant/message' || event.type === 'assistant/attempt'
              : event.type === 'session/title-llm-request')
            const physical = calls.filter(row => row.start.sessionId === sessionId && row.start.purpose === purpose)
            expect(physical, `${sessionId}: every physical ${purpose} request has exactly one ledger row`).toHaveLength(requests.length)
            expect(new Set(physical.map(row => row.start.callId)).size).toBe(requests.length)
            expect(new Set(physical.map(row => `${row.start.logicalRequestId}:${row.start.attemptIndex}`)).size).toBe(requests.length)
          }
        }
        expect(calls.every(row => row.finish !== undefined)).toBe(true)
        const runs = snapshot.rows.filter(row => row.kind === 'run')
        for (const log of logs) {
          const sessionId = fixtureContext(log).sessionIds[0]
          for (const event of parseSessionLog(log)) {
            if (event.type !== 'tool/call') continue
            const waits = snapshot.rows.filter(row => row.kind === 'event' && row.event.kind === 'wait/start'
              && row.event.sessionId === sessionId && row.event.interval.toolCallId === event.data.callId)
            expect(waits, `tool ${event.data.callId} has one durable execution start`).toHaveLength(1)
            const wait = waits[0]
            if (wait?.kind !== 'event') throw new Error('Missing tool wait evidence')
            expect(runs.filter(run => run.start.runId === wait.event.runId && run.start.sessionId === sessionId
              && run.start.startedAt <= wait.event.observedAt), 'every tool execution links to its prior durable run start').toHaveLength(1)
          }
        }
        const auxiliaryKinds = snapshot.rows.flatMap(row => row.kind === 'event' ? [row.event.kind] : [])
        expect(auxiliaryKinds.every(kind => Object.hasOwn(excludedLedgerEvents, kind)), 'ledger-only exclusion table is closed').toBe(true)
        console.info(`${scenario.name}: clean exit ${elapsed.toFixed(1)} ms / ${scenario.timeoutMs} ms`)
      } finally { await reader.fiber.dispose(); await rm(cwd, { recursive: true, force: true }) }
    }, scenario.timeoutMs + 15_000)
  }
})
