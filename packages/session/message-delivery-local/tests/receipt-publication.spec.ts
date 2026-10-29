/** Repeated claim preparation does not repeat successful receipt side effects. */
import { expect, it } from 'vitest'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { wakeupFixture } from './fixtures/wakeup.ts'

it('does not append an unchanged accepted receipt again on input preparation', async () => {
  const f = await wakeupFixture(false)
  try {
    const sent = await f.service.send({ target: { sessionId: f.session.id }, content: 'Pending handoff',
      messageClass: 'handoff', operationId: 'pending-receipt' as OperationId })
    await f.started(sent.messageId)
    await f.drain()
    const before = f.ledger.calls.length
    await f.drain()
    expect(f.ledger.calls).toHaveLength(before)
  } finally { await f.dispose() }
})
