import { afterEach, expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { JournalSessionLedger } from '../src/index.ts'
import { messageEventId } from '../src/journal.ts'
import type { MessageLedgerEvent, LedgerEventId } from '../src/types.ts'
import { callStart, callFinish } from './fixtures.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const execute = promisify(execFile)

it('keeps old recovery, snapshots, query, export and daily headlines unchanged beside message segments', async () => {
  const home = await mkdtemp(join(import.meta.dirname, '.old-reader-'))
  homes.push(home)
  const ctx = new Context()
  const ledger = new JournalSessionLedger(ctx, { dshHome: home })
  const reader = resolve(process.env.LEDGER_COMPAT_READER_ROOT ?? join(import.meta.dirname, '../../../..'))
  const asOf = Date.now()
  const nodeId = await ledger.nodeId()
  const start = { ...callStart, nodeId, startedAt: asOf - 1000 }
  const identity = { nodeId, pid: process.pid, startIdentity: 'fixture-start', bootIdentity: 'fixture-boot', registeredAt: asOf - 1000, verification: 'verified' as const }
  try {
    await ledger.beginRun({ ...start, launchState: 'started', deliveryPaths: [], processIdentity: identity })
    await ledger.appendEvent({ schemaVersion: 1, eventId: 'observation-a' as LedgerEventId, nodeId, runId: start.runId,
      sessionId: start.sessionId, observedAt: asOf - 100, kind: 'process/observed', identity, liveness: 'confirmed' })
    await ledger.beginCall(start)
    await ledger.finishCall({ ...callFinish, endedAt: asOf - 500, observedAt: asOf - 500,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 10 }, usageState: 'complete', pricingState: 'priced', costUsd: '0.125' })
    const root = join(home, 'ledger', 'v1', nodeId)
    const hashRows = async () => {
      const files = (await readdir(join(root, 'events'), { recursive: true })).filter(path => path.endsWith('.jsonl')).sort()
      return Promise.all(files.map(async path => createHash('sha256').update(await readFile(join(root, 'events', path))).digest('hex')))
    }
    // The reader runs in a separate process so all its imports resolve against the selected frozen tree.
    const script = `
      import { pathToFileURL } from 'node:url';
      import { createHash } from 'node:crypto';
      const [tree, home, root, at] = process.argv.slice(1);
      const load = path => import(pathToFileURL(tree + '/' + path).href);
      const { Context } = await load('vendor/cordis/src/index.ts');
      const { JournalSessionLedger } = await load('packages/session/session-ledger/src/index.ts');
      const { recoverSegments } = await load('packages/session/session-ledger/src/journal.ts');
      const { selectLedger, summarizeToday } = await load('packages/session/ledger-query/src/query.ts');
      const { serializeLedger } = await load('packages/session/ledger-query/src/export.ts');
      const ctx = new Context();
      try {
        const service = new JournalSessionLedger(ctx, { dshHome: home });
        const scan = await recoverSegments(root, 1048576);
        const snapshot = { ...await service.snapshot(), asOf: Number(at) };
        const query = selectLedger(snapshot, {});
        const today = summarizeToday(snapshot, Number(at), 10000);
        const hash = value => createHash('sha256').update(value).digest('hex');
        console.log(JSON.stringify({ corrupt: scan.corrupt.length, tails: scan.tails.length, complete: scan.complete && snapshot.complete,
          events: scan.events.length, rows: snapshot.rows.length, queryHash: hash(JSON.stringify(query)), exportHash: hash(serializeLedger(snapshot, 'jsonl')),
          four: { costUsd: today.costUsd, knownTokens: today.tokens.knownTokens, cacheHitRate: today.cacheHitRate, liveSessions: today.liveSessions } }));
      } finally { await ctx.fiber.dispose(); }
    `
    const read = async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
      env.TSX_TSCONFIG_PATH = join(reader, 'tsconfig.json')
      const result = await execute(process.execPath, ['--import', join(reader, 'node_modules/tsx/dist/esm/index.mjs'), '--input-type=module', '-e', script, reader, home, root, String(asOf)], { cwd: reader, env, timeout: 30000 })
      const parsed: unknown = JSON.parse(result.stdout.trim())
      return parsed
    }
    const beforeHashes = await hashRows()
    const before = await read()
    const data: Extract<MessageLedgerEvent, { kind: 'message/state' }>['data'] = { messageId: 'message-a' as Extract<MessageLedgerEvent, { kind: 'message/state' }>['data']['messageId'],
      senderSessionId: null, targetSessionId: start.sessionId, priority: 'immediate', messageClass: 'handoff', state: 'queued',
      revision: 0, stateVersion: 0, operationId: 'operation-a' as Extract<MessageLedgerEvent, { kind: 'message/state' }>['data']['operationId'], transition: 'accepted', observedAt: asOf }
    const event: MessageLedgerEvent = { schemaVersion: 1, eventId: messageEventId({ nodeId, data }), nodeId, observedAt: asOf, kind: 'message/state', data }
    await (await ledger.messages()).append(event)
    const after = await read()
    const afterHashes = await hashRows()
    expect(after).toEqual(before)
    expect(after).toMatchObject({ corrupt: 0, tails: 0, complete: true, events: 4, rows: 3 })
    expect(afterHashes).toEqual(beforeHashes)
    expect((await ledger.queryMessages({})).items).toHaveLength(1)
    const report = JSON.stringify({ compatibility: { reader, before, after, beforeHashes, afterHashes, unchanged: true } })
    console.log(report)
    if (process.env.LEDGER_COMPAT_REPORT !== undefined) await writeFile(process.env.LEDGER_COMPAT_REPORT, report + '\n')
  } finally { await ctx.fiber.dispose() }
})
