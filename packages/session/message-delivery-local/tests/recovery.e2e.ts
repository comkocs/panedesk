import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { expect, it } from 'vitest'
import { serviceFixture } from './fixtures/persistence.ts'

it('retains offline controls through YAML composition and persists idempotent sends before receipts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'delivery-loader-'))
  const f = await serviceFixture(home)
  try {
    const request = { target: { sessionId: f.session.id }, content: 'offline', messageClass: 'handoff' as const, operationId: 'send-a' as OperationId }
    const sent = await f.service.send(request)
    expect(sent).toMatchObject({ deliveryOutcome: 'rejected', reason: 'target-closed-pending', messageState: 'queued', pending: true })
    expect(await f.service.send(request)).toEqual(sent)
    await expect(f.service.send({ ...request, content: 'different' })).rejects.toThrow('operation-conflict')
    expect(await f.service.withdraw({ messageId: sent.messageId, operationId: 'withdraw-a' as OperationId, expectedRevision: 0 }))
      .toMatchObject({ kind: 'accepted-pending-owner' })
    expect((await f.service.status(sent.messageId)).state).toBe('queued')
    expect(f.ctx.agents.list()).toEqual([])
    expect(await f.service.operationStatus('unknown-a' as OperationId)).toEqual({ kind: 'not-found', operationId: 'unknown-a' })
  } finally { await f.dispose(); await rm(home, { recursive: true, force: true }) }
})

async function runProcess(home: string, role: 'sender' | 'owner'): Promise<unknown> {
  const child = fork(fileURLToPath(new URL('./fixtures/recovery-process.ts', import.meta.url)), [home, role], {
    execArgv: ['--import', import.meta.resolve('tsx/esm')],
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../../../../tsconfig.base.json') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const pid = child.pid
  let output: unknown
  let stderr = ''
  child.on('message', (message) => { output = message })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  child.stdout?.resume()
  const timeout = setTimeout(() => { if (pid !== undefined && child.exitCode === null) child.kill('SIGKILL') }, 20000)
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`Recovery child exited ${code}: ${stderr}`)) })
    })
    return output
  } finally { clearTimeout(timeout) }
}

it('shares a mailbox across two Node processes and applies offline controls before claiming resumed input', async () => {
  const home = await mkdtemp(join(tmpdir(), 'delivery-process-'))
  try {
    const sender = await runProcess(home, 'sender')
    expect(sender).toMatchObject({ role: 'sender',
      edited: { pending: true, messageState: 'queued' }, withdrawn: { pending: true },
      controls: [{ kind: 'accepted-pending-owner' }, { kind: 'accepted-pending-owner' }, { kind: 'accepted-pending-owner' }],
      rejected: { reason: 'target-archived', messageState: 'rejected' }, archivedRecords: 0, records: [1, 2, 3, 4, 5] })
    const owner = await runProcess(home, 'owner')
    expect(owner).toMatchObject({ role: 'owner', admitted: [{ content: [{ type: 'text', text: 'offline edit' }], priority: 'immediate' }],
      results: [{ kind: 'applied' }, { kind: 'applied' }, { kind: 'applied' }],
      transitions: ['accepted', 'accepted', 'edited', 'reprioritized', 'withdrawn'],
      emitted: ['accepted', 'accepted', 'edited', 'reprioritized', 'withdrawn'] })
    if (!sender || typeof sender !== 'object' || !('edited' in sender) || !sender.edited || typeof sender.edited !== 'object' || !('messageId' in sender.edited)) throw new Error('Sender result is missing a message identity')
    expect(owner).toMatchObject({ claimed: [sender.edited.messageId], admitted: [{ id: sender.edited.messageId }] })
    if (!('pid' in sender)) throw new Error('Sender result is missing a process identity')
    expect(owner).not.toMatchObject({ pid: sender.pid })
  } finally { await rm(home, { recursive: true, force: true }) }
}, 60000)
