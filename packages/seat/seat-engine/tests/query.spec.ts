import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { auto, harness, seat, trigger } from './fixtures.ts'
import { queryEngine } from '../src/query.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
it('A24 advances filtered cursors and exports verified independent engine frames', async () => {
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  await h.engine.accept({ ...trigger(), data: { text: 'private source text' } }); await h.engine.drive()
  const decisions = h.engine.journal.projection.decisions
  const all = queryEngine(decisions, { seat, limit: 100 }).effects
  const collected = []
  let cursor: import('@panedesk/dsh-seat').EngineCursor | undefined
  for (;;) {
    const page = await h.engine.query({ seat, limit: 1, ...(cursor ? { cursor } : {}) })
    collected.push(...page.effects); cursor = page.nextCursor
    if (page.complete) break
  }
  expect(collected).toEqual(all)
  const output = join(h.home, 'export.jsonl')
  expect(await h.engine.export({ query: { limit: 1000 }, format: 'jsonl', output })).toMatchObject({ status: 'exported' })
  expect(await readFile(output, 'utf8')).not.toContain('private source text')
  expect(await h.engine.verify({ input: output })).toMatchObject({ status: 'verified', tail: 'complete' })
  expect(await readdir(join(h.home, 'ledger'))).toEqual(['engine'])
  expect(decisions.every(d => d.namespace === 'ledger/engine/v1' && d.schemaVersion === 1)).toBe(true)
})
it('A24 rejects foreign cursors without executing imported state', async () => {
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  await expect(h.engine.query({ cursor: { nodeId: 'foreign' as never, sequence: 1, effectIndex: 0 }, limit: 1 })).rejects.toThrow('Cursor')
  expect(h.creates).toEqual([])
})
