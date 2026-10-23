import { Context } from '@panedesk/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as readerPlugin from '@panedesk/dsh-seat-engine/reader'
import { SeatEngineReader } from '../src/reader.ts'
import { canonical, frame } from '../src/journal.ts'
import { config, harness, nodeId, trigger } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup() {
  const h = await harness(); cleanups.push(h.close)
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(readerPlugin, { home: h.home, nodeId, maxDecisionBytes: config.maxDecisionBytes })
  const reader = ctx.get('seatEngineQuery')
  if (!reader) throw new Error('Missing reader service')
  return { ...h, ctx, reader, root: join(h.home, 'ledger/engine/v1', nodeId, 'events') }
}
async function listing(home: string) { return (await readdir(home, { recursive: true })).sort().join('\n') }

it('reads stopped engine facts and pending state without locks, writes or runtime services', async () => {
  const h = await setup()
  await h.engine.accept({ ...trigger(), data: { text: 'private source text' } })
  const expected = await h.engine.query({ limit: 100 }), pending = await h.engine.pending({ limit: 100 })
  await h.engine.shutdown()
  const before = await listing(h.home)
  const files = await readdir(h.root)
  const bytes = await Promise.all(files.map(file => readFile(join(h.root, file))))
  expect(await h.reader.query({ limit: 100 })).toEqual(expected)
  expect(await h.reader.pending({ limit: 100 })).toEqual(pending)
  const exported = await h.reader.export({ query: { limit: 100 }, format: 'jsonl', output: join(h.home, 'must-not-exist.jsonl') })
  expect(exported).toMatchObject({ status: 'exported', complete: true, watermark: expected.watermark })
  if (exported.status !== 'exported') throw new Error('Missing export content')
  expect(exported.content).not.toContain('private source text')
  expect(await h.reader.verify({ input: join(h.root, files[0]!) })).toMatchObject({ status: 'verified', tail: 'complete' })
  expect(await listing(h.home)).toBe(before)
  expect(await Promise.all(files.map(file => readFile(join(h.root, file))))).toEqual(bytes)
  expect(h.ctx.get('seatEngine')).toBeUndefined()
  expect(h.ctx.get('seatGates')).toBeUndefined()
})

it('reads concurrently while the live writer retains ownership and adds no reader files', async () => {
  const h = await setup()
  await h.engine.accept(trigger())
  for (let index = 0; index < 8; index++) {
    const [result, written] = await Promise.all([
      h.reader.query({ limit: 1000 }), h.engine.accept(trigger('external', `event-${index}`)),
    ])
    expect(result).not.toHaveProperty('status', 'rejected')
    expect(written.status).not.toBe('rejected')
    const before = await listing(h.home)
    await h.reader.query({ limit: 1000 }); await h.reader.pending({ limit: 1000 })
    expect(await listing(h.home)).toBe(before)
  }
  expect(await h.reader.query({ limit: 1000 })).toEqual(await h.engine.query({ limit: 1000 }))
  const files = (await readdir(h.root)).sort()
  expect(files).toHaveLength(h.engine.journal.projection.sequence)
  const expected = ['ledger', 'ledger/engine', 'ledger/engine/v1', `ledger/engine/v1/${nodeId}`,
    `ledger/engine/v1/${nodeId}/events`, `ledger/engine/v1/${nodeId}/owner.lock`,
    ...files.map(file => `ledger/engine/v1/${nodeId}/events/${file}`)].sort().join('\n')
  expect(await listing(h.home)).toBe(expected)
})

it('preserves a half-frame tail and stops at the last complete frame', async () => {
  const h = await setup(); await h.engine.accept(trigger()); await h.engine.shutdown()
  const expected = await h.reader.query({ limit: 100 })
  const file = join(h.root, (await readdir(h.root))[0]!)
  await appendFile(file, '{"namespace":')
  const before = await readFile(file)
  expect(await h.reader.query({ limit: 100 })).toEqual({ ...expected, complete: false })
  expect(await h.reader.pending({ limit: 100 })).toMatchObject({ complete: false, watermark: 1 })
  expect(await h.reader.verify({ input: file })).toMatchObject({ status: 'verified', tail: 'fragment-preserved' })
  expect(await readFile(file)).toEqual(before)
})

it('treats an empty newly created segment as an incomplete concurrent append', async () => {
  const h = await setup(); await h.engine.accept(trigger())
  await writeFile(join(h.root, '0000000000000002-tail.jsonl'), '')
  expect(await h.reader.query({ limit: 100 })).toMatchObject({ complete: false, watermark: 1 })
})

it('does not create a missing home or an absent engine journal', async () => {
  const h = await setup()
  const missing = join(h.home, 'missing-home')
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  const reader = new SeatEngineReader(ctx, { home: missing, maxDecisionBytes: config.maxDecisionBytes })
  const before = await listing(h.home)
  expect(await reader.query({ limit: 1 })).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
  expect(await reader.pending({ limit: 1 })).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
  expect(await reader.export({ query: { limit: 1 }, format: 'jsonl', output: join(missing, 'export.jsonl') }))
    .toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
  expect(await h.reader.query({ limit: 1 })).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
  expect(await listing(h.home)).toBe(before)
})

it('reads the existing accounting node identity without initializing it', async () => {
  const h = await setup(); await h.engine.accept(trigger())
  await mkdir(join(h.home, 'ledger/v1')); await writeFile(join(h.home, 'ledger/v1/node-id'), nodeId)
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  const reader = new SeatEngineReader(ctx, { home: h.home, maxDecisionBytes: config.maxDecisionBytes })
  const before = await listing(h.home)
  expect(await reader.query({ limit: 100 })).toEqual(await h.reader.query({ limit: 100 }))
  expect(await listing(h.home)).toBe(before)
})

it.each(['json', 'checksum', 'sequence', 'node'])('rejects complete %s corruption without repairing files', async (kind) => {
  const h = await setup(); await h.engine.accept(trigger()); await h.engine.shutdown()
  const decision = h.engine.journal.projection.decisions[0]!
  const file = join(h.root, (await readdir(h.root))[0]!)
  const { digest: _digest, byteLength: _bytes, ...body } = decision
  const text = kind === 'json' ? '{bad json}\n' : canonical(kind === 'checksum' ? { ...decision, digest: 'bad' }
    : frame({ ...body, ...(kind === 'sequence' ? { sequence: 2 } : { nodeId: 'node-b' as typeof nodeId }) })) + '\n'
  await writeFile(file, text)
  expect(await h.reader.query({ limit: 100 })).toMatchObject({ status: 'rejected', error: { code: 'engine-store-corrupt' } })
  expect(await readFile(file, 'utf8')).toBe(text)
  await rm(file)
})
