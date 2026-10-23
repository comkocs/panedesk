import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EngineJournal, canonical, decodeFrame, frame } from '../src/journal.ts'
import { fact } from '../src/triggers.ts'
import { config, nodeId, projectId } from './fixtures.ts'
import type * as T from '@panedesk/dsh-seat'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup() {
  const root = await mkdtemp(join(process.cwd(), 'packages/seat/seat-engine/tests/.journal-'))
  const journals: EngineJournal[] = []
  const create = async () => { const j = new EngineJournal(root, nodeId, config.maxDecisionBytes)
    journals.push(j); await j.ready(); return j }
  cleanups.push(async () => { for (const j of journals) await j.close(); await rm(root, { recursive: true, force: true }) })
  return { root, create, journal: await create() }
}
const policy = () => fact({ kind: 'mode/changed', data: { policy: { projectId, mode: 'auto',
  modeChosen: true, revision: 1 }, previousMode: 'remind', previousRevision: 0, principalId: 'principal-a' as T.SeatPrincipalId } })
it('A09 serializes complete frames and excludes a second native writer', async () => {
  const h = await setup()
  await expect(h.create()).rejects.toThrow('ownership')
  await Promise.all(Array.from({ length: 5 }, () => h.journal.commit(() => [policy()])))
  expect(h.journal.projection.decisions.map(d => d.sequence)).toEqual([1, 2, 3, 4, 5])
  await h.journal.close(); const restored = await h.create()
  expect(restored.projection.sequence).toBe(5)
})
it('A09 preserves an interrupted final fragment and freezes complete corrupt frames', async () => {
  const h = await setup(); await h.journal.commit(() => [policy()]); await h.journal.close()
  const fragment = join(h.root, 'events', '9999999999999999-tail.jsonl')
  await writeFile(fragment, '{"namespace":')
  const recovered = await h.create(); expect(recovered.projection.sequence).toBe(1)
  expect(await readFile(fragment, 'utf8')).toBe('{"namespace":')
  await recovered.close()
  const file = (await readdir(join(h.root, 'events'))).find(file => !file.startsWith('999'))!
  await writeFile(join(h.root, 'events', file), '{"broken":true}\n')
  await expect(h.create()).rejects.toThrow('recovery')
})
it('A09 rejects unknown schemas and complete frame byte overflow', async () => {
  const h = await setup(); const decision = await h.journal.commit(() => [policy()])
  expect(() => decodeFrame(canonical({ ...decision, schemaVersion: 2 }), config.maxDecisionBytes)).toThrow('header')
  expect(() => decodeFrame(canonical(decision), 1)).toThrow('bound')
  expect(() => decodeFrame(canonical(frame({ ...decision!, effects: [] })), config.maxDecisionBytes)).toThrow()
})
