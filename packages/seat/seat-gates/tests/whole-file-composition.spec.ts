/** Real compaction keeps seat files and the ledger's live-child inventory together. */
import { expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import BasicCompactionEngine from '@panedesk/dsh-compaction-basic'
import * as LedgerCheckpoint from '@panedesk/dsh-compaction-ledger'
import TokenMeter from '@panedesk/dsh-token-meter'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'
import { localHost } from './local-host.ts'
import { CreationAdapter } from '../../seat-local/tests/creation-provider.ts'
import { operation } from '../../seat-local/tests/fixtures.ts'

class HoldingChildAdapter extends CreationAdapter {
  readonly release = Promise.withResolvers<undefined>()
  readonly entered = Promise.withResolvers<undefined>()
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (JSON.stringify(options.messages).includes('HOLD_CHECKPOINT_CHILD')) {
      this.entered.resolve(undefined)
      await this.release.promise
    }
    yield* super.stream(options)
  }
}

it('restores full files in the first request after each of two compactions and matches live ledger children', async () => {
  const model = new HoldingChildAdapter()
  const f = await localHost(model, { ledgerCheckpointReserveTokens: 4096 }, true)
  try {
    f.ctx.loader.builtins.tokenMeter = TokenMeter
    f.ctx.loader.builtins.ledgerCheckpoint = LedgerCheckpoint
    f.ctx.loader.builtins.compaction = BasicCompactionEngine
    await f.load('checkpoint.yml', [{ name: 'cordis:tokenMeter' },
      { name: 'cordis:ledgerCheckpoint', config: { maxTokens: 8000, recentEventLimit: 0 } },
      { name: 'cordis:compaction', config: { auto: false } }])
    const compact = f.ctx.get('compaction')
    if (compact === undefined) throw new Error('Missing production compaction engine')
    const path = join(f.root, 'whole-checkpoint.md')
    await writeFile(path, '# Rules\nWHOLE_FIRST\n# Other\nWHOLE_SECOND\n')
    const sourcePath = join(f.root, 'seats.csv')
    await writeFile(sourcePath, 'seat,model\nseat-a,model-a\n')
    const plan = await f.seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' },
      defaults: { checkpointFiles: [{ path, section: 'Ignored', mode: 'file', maxBytes: 4096, required: true }] } })
    if ('status' in plan) throw new Error(JSON.stringify(plan))
    await f.seats.commitImport({ planId: plan.planId, selectedRows: plan.rows.map(row => row.row), expectedRevision: 0,
      operationId: operation('whole-import') })
    const opened = await f.seats.open({ seat: f.defaults.seat, origin: 'manual', openingMode: 'prefill', operationId: operation('whole-open') })
    if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
    const agent = f.ctx.agents.get(opened.sessionId)!
    const followup = async (text: string) => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    await followup('Initial conversation. '.repeat(3000))
    const child = await f.ctx.subagents.startActivation({ provider: 'spawn', label: 'checkpoint child', delivery: 'caller',
      request: { parent: agent, prompt: [{ type: 'text', text: 'HOLD_CHECKPOINT_CHILD' }] }, signal: new AbortController().signal })
    await model.entered.promise
    try {
      for (let pass = 1; pass <= 2; pass++) {
        const full = `# Rules\nWHOLE_FIRST_${pass}\n# Other\nWHOLE_SECOND_${pass}\n`
        await writeFile(path, full)
        const before = await f.ctx.sessionLedger.snapshot({ sessionId: agent.id, includeChildren: true })
        const live = before.rows.filter(row => row.kind === 'run' && row.start.subagentRunId !== undefined
          && row.finish === undefined && row.liveness !== 'dead')
        expect(live.length).toBeGreaterThan(0)
        expect(await compact.compactNow(agent, new AbortController().signal)).not.toBeNull()
        const checkpoint = agent.session.deriveMessages().map(message => message.content).flat()
          .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        expect(checkpoint).toContain(JSON.stringify(full))
        for (const row of live) if (row.kind === 'run') {
          expect(checkpoint).toContain(`"subagentRunId":"${row.start.subagentRunId}"`)
          expect(checkpoint).toContain(`"runId":"${row.start.runId}"`)
        }
        const count = model.requests.length
        await followup(`FIRST_AFTER_COMPACTION_${pass} ${'History padding. '.repeat(3000)}`)
        console.log('Post-compaction turn outcome:', JSON.stringify(agent.session.snapshotEvents()
          .filter(event => event.type === 'turn/end').at(-1)))
        console.log('Checkpoint evidence:', JSON.stringify({ pass, full,
          live: live.map(row => row.kind === 'run' ? { runId: row.start.runId, subagentRunId: row.start.subagentRunId } : null),
          checkpoint }))
        expect(model.requests.length).toBe(count + 1)
        const request = JSON.stringify(model.requests.at(-1))
        expect(request).toContain(`WHOLE_FIRST_${pass}`)
        expect(request).toContain(`WHOLE_SECOND_${pass}`)
        expect(request).toContain(child.childId)
      }
      await f.ctx.sessions.flush(agent.session)
      const persisted = await f.ctx.sessionQuery.readSession(agent.id)
      expect(persisted.events.filter(event => event.type === 'compaction/summary')).toHaveLength(2)
    } finally { model.release.resolve(undefined); await child.result }
  } finally { model.release.resolve(undefined); await f.close() }
}, 30000)
