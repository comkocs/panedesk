import { afterEach, expect, it } from 'vitest'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { appendUnique, JournalViewOwner, readJournal, recoverSegments } from '../src/journal.ts'
import type { LedgerAppendResult, LedgerEvent, LedgerEventId } from '../src/types.ts'
import { event, options } from './fixtures.ts'

const roots: string[] = []
const execute = promisify(execFile)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function oldWatermark(root: string): Promise<Buffer> {
  const reader = resolve(process.env.LEDGER_COMPAT_READER_ROOT ?? join(import.meta.dirname, '../../../..'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  env.TSX_TSCONFIG_PATH = join(reader, 'tsconfig.json')
  const script = `
    import { pathToFileURL } from 'node:url';
    const [tree, root] = process.argv.slice(1);
    const { recoverSegments } = await import(pathToFileURL(tree + '/packages/session/session-ledger/src/journal.ts').href);
    const scan = await recoverSegments(root, 1048576);
    if (!scan.complete) throw new Error('Incomplete compatibility fixture');
    process.stdout.write(scan.watermark);
  `
  const result = await execute(process.execPath, ['--import', pathToFileURL(join(reader, 'node_modules/tsx/dist/esm/index.mjs')).href,
    '--input-type=module', '-e', script, reader, root], { cwd: reader, env, timeout: 30000 })
  return Buffer.from(result.stdout)
}

for (const [label, fixture] of [
  ['V0', process.env.LEDGER_COMPAT_V0_ROOT],
  ['V0b', process.env.LEDGER_COMPAT_V0B_ROOT],
  ['Windows', process.env.LEDGER_COMPAT_WINDOWS_ROOT],
  ['segmented', undefined],
] as const) {
  it.skipIf(label !== 'segmented' && fixture === undefined)(`keeps the ${label} incremental watermark byte-identical to the full-scan reader`, async () => {
    const root = await mkdtemp(join(import.meta.dirname, '.watermark-compat-'))
    roots.push(root)
    if (fixture !== undefined) await cp(fixture, root, { recursive: true })
    const viewOwner = new JournalViewOwner()
    const retained = { ...options, viewOwner }
    try {
      if (label === 'segmented') {
        await appendUnique(root, event(), retained)
        await appendUnique(root, event('call/end'), retained)
      }
      const compare = async () => {
        const scan = await readJournal(root, retained)
        expect(Buffer.from(scan.watermark)).toEqual(Buffer.from((await recoverSegments(root, options.maxRecordBytes)).watermark))
        expect(scan.complete).toBe(true)
        expect(scan.events.length).toBeGreaterThan(0)
        const bytes = Buffer.from(scan.watermark)
        expect(bytes).toHaveLength(64)
        expect(bytes).toEqual(await oldWatermark(root))
      }
      await compare()
      await compare()
      if (label === 'segmented') {
        await appendUnique(root, event('run/start'), options)
        await compare()
      }
      const delayed: { result: Exclude<LedgerAppendResult, { kind: 'conflict' }>; bytes: Buffer }[] = []
      for (let step = 0; step < 3; step++) {
        const fact: LedgerEvent = { ...event(), kind: 'alert', eventId: `watermark:${step}` as LedgerEventId,
          alert: { code: 'watermark-fixture', message: 'Synthetic watermark fixture.', redacted: false } }
        const result = await appendUnique(root, fact, retained)
        if (result.kind === 'conflict') throw new Error('Unexpected fixture conflict')
        const bytes = await oldWatermark(root)
        delayed.push({ result, bytes })
        const replay = await appendUnique(root, fact, retained)
        if (replay.kind === 'conflict') throw new Error('Unexpected replay conflict')
        expect(replay.kind).toBe('existing')
        expect(Buffer.from(replay.watermark)).toEqual(bytes)
        await compare()
      }
      const beforeChild = await oldWatermark(root)
      const reader = resolve(join(import.meta.dirname, '../../../..'))
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
      env.TSX_TSCONFIG_PATH = join(reader, 'tsconfig.json')
      const script = `
        import { pathToFileURL } from 'node:url';
        const [tree, root] = process.argv.slice(1);
        const { appendUnique, JournalViewOwner } = await import(pathToFileURL(tree + '/packages/session/session-ledger/src/journal.ts').href);
        const { event, options } = await import(pathToFileURL(tree + '/packages/session/session-ledger/tests/fixtures.ts').href);
        const owner = new JournalViewOwner();
        try {
          for (let i = 0; i < 3; i++) await appendUnique(root, { ...event(), kind: 'alert', eventId: 'child:' + i,
            alert: { code: 'watermark-fixture', message: 'Concurrent fixture.', redacted: false } }, { ...options, viewOwner: owner });
        } finally { owner.dispose(); }
      `
      const writing = execute(process.execPath, ['--import', pathToFileURL(join(reader, 'node_modules/tsx/dist/esm/index.mjs')).href,
        '--input-type=module', '-e', script, reader, root], { cwd: reader, env, timeout: 30000 })
      await Promise.all([writing, appendUnique(root, { ...event(), kind: 'alert', eventId: 'parent:concurrent' as LedgerEventId,
        alert: { code: 'watermark-fixture', message: 'Concurrent parent fixture.', redacted: false } }, retained)])
      await compare()
      expect((await oldWatermark(root)).equals(beforeChild)).toBe(false)
      const replay = await appendUnique(root, { ...event(), kind: 'alert', eventId: 'watermark:0' as LedgerEventId,
        alert: { code: 'watermark-fixture', message: 'Synthetic watermark fixture.', redacted: false } }, retained)
      if (replay.kind === 'conflict') throw new Error('Unexpected refreshed replay conflict')
      expect(Buffer.from(replay.watermark)).toEqual(await oldWatermark(root))
      viewOwner.dispose()
      for (const { result, bytes } of delayed) {
        expect(Buffer.from(result.watermark)).toEqual(bytes)
        expect(Buffer.from(structuredClone(result).watermark)).toEqual(bytes)
        expect(JSON.stringify(result)).toBe(JSON.stringify({ kind: result.kind, event: result.event, watermark: bytes.toString() }))
      }
    } finally { viewOwner.dispose() }
  }, 30000)
}
