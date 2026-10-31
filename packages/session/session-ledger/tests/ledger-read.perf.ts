/** Offline diagnostic for durable write latency and full read, query and export scaling. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { JournalSessionLedger } from '../src/index.ts'
import { canonicalJson, digest } from '../src/index-store.ts'
import { LedgerQueryService } from '@panedesk/dsh-ledger-query'
import { callStart, callFinish } from './fixtures.ts'
import type { LedgerEvent, LedgerCallStart } from '../src/types.ts'

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.floor(ordered.length / 2)]!
}
async function timed(operation: () => Promise<unknown>): Promise<number> {
  const start = performance.now()
  await operation()
  return performance.now() - start
}
function startAt(index: number): LedgerCallStart {
  return { ...callStart, callId: `call-${index}` as LedgerCallStart['callId'],
    sessionId: `session-${index}` as LedgerCallStart['sessionId'],
    parentSessionId: `session-${index - 1}` as LedgerCallStart['sessionId'],
    runId: `run-${index}` as LedgerCallStart['runId'], startedAt: 1000000 - index }
}
for (const count of [1000, 10000, 100000]) {
  const home = await mkdtemp(join(tmpdir(), 'ledger-read-perf-'))
  const ctx = new Context()
  try {
    const ledger = new JournalSessionLedger(ctx, { dshHome: home })
    const query = new LedgerQueryService(ctx)
    const node = await ledger.nodeId()
    const directory = join(home, 'ledger/v1', node, 'events/2000-01-01')
    await mkdir(directory, { recursive: true })
    const lines: string[] = []
    for (let i = 0; i < count; i++) {
      const start = startAt(i)
      const payload: LedgerEvent = { schemaVersion: 1, eventId: `call/start:${i}` as LedgerEvent['eventId'],
        kind: 'call/start', callId: start.callId, sessionId: start.sessionId, runId: start.runId,
        nodeId: start.nodeId, observedAt: start.startedAt, data: start }
      const text = canonicalJson(payload)
      lines.push(canonicalJson({ version: 1, bytes: Buffer.byteLength(text), digest: digest(text), payload }))
    }
    await writeFile(join(directory, 'segment-fixture.jsonl'), lines.join('\n') + '\n', { mode: 0o600 })
    const coldReadMs = await timed(() => ledger.snapshot())
    const readMs = await timed(() => ledger.snapshot())
    const queryMs = await timed(() => query.query({ sessionId: 'session-0' as LedgerCallStart['sessionId'], includeChildren: true }))
    const exportMs = await timed(() => query.export({ query: {}, format: 'jsonl', outputPath: join(home, 'export.jsonl') }))
    console.log(JSON.stringify({ count, coldReadMs, readMs, queryMs, exportMs,
      rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, peakRssKiB: process.resourceUsage().maxRSS }))
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
}
for (const count of [50, 1000, 3000]) {
  const home = await mkdtemp(join(tmpdir(), 'ledger-write-perf-'))
  const ctx = new Context()
  try {
    const ledger = new JournalSessionLedger(ctx, { dshHome: home })
    await ledger.nodeId()
    const samples: number[] = []
    for (let i = 0; i < count; i++) {
      const start = startAt(i)
      samples.push(await timed(async () => {
        await ledger.beginCall(start)
        await ledger.finishCall({ ...callFinish, callId: start.callId })
      }))
    }
    const segments = Array.from({ length: 10 }, (_, i) =>
      median(samples.slice(Math.floor(i * count / 10), Math.floor((i + 1) * count / 10))))
    console.log(JSON.stringify({ writeCalls: count, medianMs: median(samples), segments,
      rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, peakRssKiB: process.resourceUsage().maxRSS }))
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
}
