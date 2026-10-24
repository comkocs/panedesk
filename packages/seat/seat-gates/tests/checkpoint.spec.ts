import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCheckpoint, selectSection } from '../src/checkpoint.ts'
import { installConsumers } from '../src/consumers.ts'
import { config, profile, seatStub } from './harness.ts'
import { harness } from '../../tool-seat/tests/harness.ts'
import type { SeatBinding, SeatService, SeatGateService } from '@panedesk/dsh-seat'
import { SessionSeq } from '@panedesk/dsh-session'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function source() {
  const root = await mkdtemp(join(tmpdir(), 'seat-gates-checkpoint-'))
  roots.push(root)
  const path = join(root, 'rules.md')
  await writeFile(path, '# Rules\nKeep complete data.\n# Other\nOmit this section.\n')
  return { path, section: 'Rules', maxBytes: 4096, required: true }
}

describe('checkpoint data contribution', () => {
  it('delegates in ledger-seat-base order and keeps the producer strict-shrink allowance intact', async () => {
    const file = await source()
    const { ctx, agent } = await harness()
    const definition = { ...profile, checkpointFiles: [file] }
    const binding: SeatBinding = { kind: 'seat', sessionId: agent.session.id, seat: profile.seat, projectId: profile.projectId,
      nodeId: 'node-a' as SeatBinding['nodeId'], bindingSource: 'seat-definition', identitySource: 'settings',
      openOperationId: 'open-a' as import('@panedesk/dsh-seat').SeatOperationId, seatRevision: 1,
      relatedTaskIds: [], directories: [], memoryDirectories: [], subscriptions: [],
      openingDigest: 'digest-a' as import('@panedesk/dsh-seat').SeatDigest }
    const seats = seatStub(definition, binding)
    ctx.provide('seats', seats as SeatService)
    ctx.provide('seatLocalRead', seats)
    const gates = { evaluate: async () => [] } as Partial<SeatGateService> as SeatGateService
    const order: string[] = []
    ctx.on('compaction/checkpoint', async (_payload, next) => {
      order.push('ledger')
      const result = await next()
      return { ...result, content: [...result.content, { type: 'text', text: 'Ledger child-a' }] }
    })
    installConsumers(ctx, config, gates)
    const checkpoint = { sessionSeq: SessionSeq(1), content: [{ type: 'text' as const, text: 'Summary' }] }
    const estimateTokens = (content: import('@panedesk/dsh-compaction').CompactionCheckpoint['content']) =>
      content.reduce((total, item) => total + (item.type === 'text' ? item.text.length : 0), 0)
    const run = (additionalTokenBudget: number) => ctx.waterfall('compaction/checkpoint',
      { session: agent.session, checkpoint, additionalTokenBudget, estimateTokens },
      async () => { order.push('base'); return checkpoint })
    try {
      const result = await run(4096)
      const text = JSON.stringify(result.content)
      expect(order).toEqual(['ledger', 'base'])
      expect(text.indexOf('Summary')).toBeLessThan(text.indexOf('Seat checkpoint data'))
      expect(text.indexOf('Seat checkpoint data')).toBeLessThan(text.indexOf('Ledger child-a'))
      expect(estimateTokens(result.content as typeof checkpoint.content) - estimateTokens(checkpoint.content)).toBeLessThanOrEqual(4096)
      expect(await result.validate?.()).toBe(true)
      await writeFile(file.path, '# Rules\nChanged data.\n')
      expect(await result.validate?.()).toBe(false)
      await expect(run(1)).rejects.toThrow('budget')
    } finally { await ctx.fiber.dispose() }
  })
  it('appends complete quoted data after the summary and validates its frozen evidence', async () => {
    const file = await source()
    const result = await buildCheckpoint([file], 3, 4096, 4096, 512, text => text.length)
    const combined = `Summary${result.text}\nLedger inventory`
    expect(combined.indexOf('Summary')).toBeLessThan(combined.indexOf('Seat checkpoint data'))
    expect(combined.indexOf('Seat checkpoint data')).toBeLessThan(combined.indexOf('Ledger inventory'))
    expect(result.text).toContain('# Rules\\nKeep complete data.')
    expect(result.text).not.toContain('Omit this section')
    expect(result.evidence[0]).toMatchObject({ path: file.path, revision: 3 })
    expect(await result.validate()).toBe(true)
    await writeFile(file.path, '# Rules\nChanged data.\n')
    expect(await result.validate()).toBe(false)
  })
  it('rejects missing required sections and budget exhaustion without truncation', async () => {
    const file = await source()
    await expect(buildCheckpoint([{ ...file, section: 'Missing' }], 1, 4096, 4096, 512, text => text.length)).rejects.toThrow('missing')
    await expect(buildCheckpoint([file], 1, 4096, 512, 512, text => text.length)).rejects.toThrow('budget')
    await expect(buildCheckpoint([file], 1, 1, 4096, 512, text => text.length)).rejects.toThrow('budget')
  })
  it('reports optional omissions and refuses ambiguous heading selection', async () => {
    const file = await source()
    const result = await buildCheckpoint([{ ...file, required: false, section: 'Missing' }], 1, 4096, 4096, 0, text => text.length)
    expect(result.omitted).toEqual([file.path])
    expect(result.text).toContain('omitted')
    expect(selectSection('# Rules\na\n# Rules\nb\n', 'Rules')).toBeNull()
  })
})
