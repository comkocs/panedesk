/** Test-only process recreates a Loader host over durable child binding facts. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import { completesIdleTurn } from '../../seat/tests/completion.ts'
import { childBindingHost, createBoundChain } from './child-binding-fixture.ts'

const root = process.argv[2]
const phase = process.argv[3]
if (!root || !phase) throw new Error('Missing test storage or phase')
const f = await childBindingHost(root)
try {
  if (phase === 'create') {
    const chain = await createBoundChain(f)
    await writeFile(join(root, 'chain.json'), JSON.stringify(chain))
    process.send?.({ kind: 'created', pid: process.pid, sessions: chain.ids.length })
  } else {
    const chain = JSON.parse(await readFile(join(root, 'chain.json'), 'utf8')) as { ids: SessionId[]; binding: object }
    assert.equal(chain.ids.length, 5)
    for (const sessionId of chain.ids.slice(1)) {
      const binding = await f.ctx.get('seatLocalRead')!.binding({ sessionId })
      assert.deepEqual(binding, { ...chain.binding, sessionId, identitySource: 'inherited' })
      const handle = await f.ctx.agents.resume({ resumeSessionId: sessionId })
      try {
        const position = chain.ids.indexOf(sessionId)
        assert.equal(handle.agent.session.header.parentSession, chain.ids[position - 1])
        await completesIdleTurn(f.ctx, handle.agent, () => { handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'Verify inherited binding after restart.' }], source: { kind: 'user' },
        })) })
        const rows = (await f.ctx.sessionLedger.query({ sessionId })).rows.filter(row => row.kind === 'run')
        assert.ok(rows.length >= (phase === 'resume' ? 2 : 3))
        assert.ok(rows.every(row => row.start.identitySource === 'inherited' && row.start.seat === f.definition.seat))
      } finally { await handle.dispose() }
    }
    process.send?.({ kind: phase, pid: process.pid, inherited: chain.ids.length - 1 })
  }
} finally { await f.close() }
