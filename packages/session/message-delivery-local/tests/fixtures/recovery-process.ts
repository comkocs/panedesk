/** Source entry for two-process recovery; substitutes scheduling and Session persistence, not the file mailbox. */
import { SessionId } from '@panedesk/dsh-session'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { serviceFixture } from './persistence.ts'
import { FileMailbox } from '../../src/mailbox.ts'

const [home, role] = process.argv.slice(2)
if (!home || (role !== 'sender' && role !== 'owner')) throw new Error('Missing test home or process role')
const f = await serviceFixture(home)
const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
try {
  if (role === 'sender') {
    const edited = await f.service.send({ target: { sessionId: f.session.id }, content: 'original', messageClass: 'handoff', operationId: 'send-edit' as OperationId })
    const withdrawn = await f.service.send({ target: { sessionId: f.session.id }, content: 'pending withdrawal', messageClass: 'handoff', operationId: 'send-withdraw' as OperationId })
    const controls = [
      await f.service.edit({ messageId: edited.messageId, content: 'offline edit', expectedRevision: 0, operationId: 'edit-a' as OperationId }),
      await f.service.reprioritize({ messageId: edited.messageId, priority: 'immediate', expectedRevision: 1, operationId: 'priority-a' as OperationId }),
      await f.service.withdraw({ messageId: withdrawn.messageId, expectedRevision: 0, operationId: 'withdraw-a' as OperationId }),
    ]
    const archived = f.ctx.sessions.create(SessionId('archived-a'))
    await (await f.ctx.sessionPersistence.create(archived.header)).close()
    f.ctx.reflect.provide('workspaceRegistry', { archivedSessionIds: [archived.id], list: () => [] })
    const rejected = await f.service.send({ target: { sessionId: archived.id }, content: 'must not enter the mailbox', messageClass: 'handoff', operationId: 'archive-a' as OperationId })
    process.send?.({ role, pid: process.pid, edited, withdrawn, controls, rejected,
      archivedRecords: (await mailbox.snapshot(archived.id)).records.length,
      records: (await mailbox.snapshot(f.session.id)).records.map(record => record.sequence) })
  } else {
    const scheduler = await f.resume()
    // The substitute claims only after announce returns and all offline controls have settled.
    const admitted = scheduler.queue.map(message => ({ id: message.id, content: message.content,
      priority: scheduler.options.get(message.id)?.priority }))
    const results = await Promise.all(['edit-a', 'priority-a', 'withdraw-a'].map(id => f.service.operationStatus(id as OperationId)))
    const claimed = scheduler.queue.splice(0).map(message => message.id)
    process.send?.({ role, pid: process.pid, admitted, results, claimed,
      transitions: (await f.ledger.read()).events.flatMap(event => event.kind === 'message/state' ? [event.data.transition] : []),
      emitted: f.emitted.map(event => event.data.transition) })
  }
} finally {
  await f.dispose()
  process.disconnect?.()
}
