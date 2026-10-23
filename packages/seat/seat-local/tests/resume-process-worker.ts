/** Test-only Loader host retains Session and ledger storage across process lifetimes. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { completeTurn } from '../../seat/tests/completion.ts'

const root = process.argv[2]
const phase = process.argv[3]
if (!root || !phase) throw new Error('Missing test storage or phase')
const f = await admissionHost(root)
const id = 'process-resume' as SessionId
try {
  if (phase === 'create') {
    await f.seats.save({ definition: { ...f.definition,
      directories: [{ path: join(root, 'owned'), startup: true }] }, expectedRevision: 2, operationId: operation('narrow-root') })
    const handle = await f.ctx.agents.create({ sessionId: id, meta: { cwd: root } })
    await handle.dispose()
  } else {
    const prior = (await f.ctx.sessionLedger.query({ sessionId: id })).rows.filter(row => row.kind === 'run')
    assert.equal(prior.length, phase === 'resume' ? 1 : 2)
    if (phase === 'verify') {
      assert.ok(prior.some(row => row.start.identitySource === 'startup' && row.start.window === 'window-a'))
    }
    f.ctx.provide('ledgerStartupIdentity', { seat: 'seat-a', window: 'window-a', taskId: 'task-a' })
    let firstObserved = false
    const off = f.ctx.on('agent/created', async ({ agent, source }) => {
      if (agent.id !== id || source !== 'resume') return
      const rows = (await f.ctx.sessionLedger.query({ sessionId: id })).rows.filter(row => row.kind === 'run')
      const added = rows.filter(row => !prior.some(old => old.start.runId === row.start.runId))
      assert.equal(added.length, 1)
      assert.equal(added[0]?.start.seat, 'seat-a')
      assert.equal(added[0]?.start.window, 'window-a')
      assert.equal(added[0]?.start.identitySource, 'startup')
      firstObserved = true
    })
    const handle = await f.ctx.agents.resume({ resumeSessionId: id })
    assert.ok(firstObserved)
    await completeTurn(f.ctx, handle.agent, () => { handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Resume task' }], source: { kind: 'user' },
    })) })
    off()
    await handle.dispose()
    assert.equal(f.ctx.sessionLedger.contextFor(id), undefined)
    await writeFile(join(root, `${phase}.json`), JSON.stringify({ pid: process.pid, firstObserved,
      runs: (await f.ctx.sessionLedger.query({ sessionId: id })).rows.filter(row => row.kind === 'run').length }))
  }
} finally { await f.close() }
