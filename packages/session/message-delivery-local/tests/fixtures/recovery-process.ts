/** 双进程恢复验收的源码入口；仅替换调度和会话持久化，不替换文件信箱。 */
import { SessionId } from '@panedesk/dsh-session'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { serviceFixture } from './persistence.ts'
import { FileMailbox } from '../../src/mailbox.ts'

const [home, role] = process.argv.slice(2)
if (!home || (role !== 'sender' && role !== 'owner')) throw new Error('缺少测试家目录或进程角色')
const f = await serviceFixture(home)
const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
try {
  if (role === 'sender') {
    const edited = await f.service.send({ target: { sessionId: f.session.id }, content: '原文', messageClass: 'handoff', operationId: 'send-edit' as OperationId })
    const withdrawn = await f.service.send({ target: { sessionId: f.session.id }, content: '待撤', messageClass: 'handoff', operationId: 'send-withdraw' as OperationId })
    const controls = [
      await f.service.edit({ messageId: edited.messageId, content: '离线改字', expectedRevision: 0, operationId: 'edit-a' as OperationId }),
      await f.service.reprioritize({ messageId: edited.messageId, priority: 'immediate', expectedRevision: 1, operationId: 'priority-a' as OperationId }),
      await f.service.withdraw({ messageId: withdrawn.messageId, expectedRevision: 0, operationId: 'withdraw-a' as OperationId }),
    ]
    const archived = f.ctx.sessions.create(SessionId('archived-a'))
    await (await f.ctx.sessionPersistence.create(archived.header)).close()
    f.ctx.reflect.provide('workspaceRegistry', { archivedSessionIds: [archived.id], list: () => [] })
    const rejected = await f.service.send({ target: { sessionId: archived.id }, content: '不应存入信箱', messageClass: 'handoff', operationId: 'archive-a' as OperationId })
    process.send?.({ role, pid: process.pid, edited, withdrawn, controls, rejected,
      archivedRecords: (await mailbox.snapshot(archived.id)).records.length,
      records: (await mailbox.snapshot(f.session.id)).records.map(record => record.sequence) })
  } else {
    const scheduler = await f.resume()
    // announce 返回后才允许替身 claim；此时全部离线控制已经裁决。
    const admitted = scheduler.queue.map(message => ({ id: message.id, content: message.content,
      priority: scheduler.options.get(message.id)?.priority }))
    const results = await Promise.all(['edit-a', 'priority-a', 'withdraw-a'].map(id => f.service.operationStatus(id as OperationId)))
    const claimed = scheduler.queue.splice(0).map(message => message.id)
    process.send?.({ role, pid: process.pid, admitted, results, claimed,
      transitions: (await f.ledger.read()).events.map(event => event.data.transition),
      emitted: f.emitted.map(event => event.data.transition) })
  }
} finally {
  await f.dispose()
  process.disconnect?.()
}
