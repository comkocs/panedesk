/** Real input barriers retain claimed or injected opening evidence for a parent-owned crash. */
import { setTimeout as delay } from 'node:timers/promises'
import { createTestGate } from '@panedesk/dsh-agent-loop-testkit'
import type { GenerateOptions, StreamChunk } from '@panedesk/dsh-llm'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { digest } from '../src/store.ts'

const [root, boundary] = process.argv.slice(2)
if (!root || (boundary !== 'claimed' && boundary !== 'injected')) throw new Error('Missing input boundary')
const host = await admissionHost(root)
const preparing = createTestGate(), claimed = createTestGate(), injected = createTestGate()
const received: T.SeatCallbackPayload[] = []
const reference: T.OpeningContextReference = { providerId: 'restart-provider' as T.OpeningProviderId,
  reference: 'restart-task' as T.OpeningContextReference['reference'], revision: '1' }
host.ctx.get('seatOpeningContexts')!.register({ providerId: reference.providerId,
  resolve: async () => ({ reference, text: 'Retained opening', digest: digest('Retained opening'),
    revision: '1', taskIds: [], scopeEvidence: [] }),
  callback: async (payload) => { received.push(payload) } })
host.ctx.on('agent/input-preparing', async ({ signal }) => { await preparing.wait(signal) })
host.ctx.on('agent/request', async ({ signal }, next) => {
  if (boundary === 'claimed') await claimed.wait(signal)
  return next()
})
const stream = host.adapter.stream.bind(host.adapter)
host.adapter.stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
  await injected.wait(options.signal)
  yield* stream(options)
}
const opened = await host.ctx.get('seatOpeningContexts')!.open({ seat: host.definition.seat, origin: 'manual',
  openingMode: 'auto', operationId: operation(`control-${boundary}`), openingContext: reference,
  relatedTaskIds: [] }, host.authority)
if (opened.status !== 'opened') throw new Error('Opening was not admitted')
const open = host.engine.journal.projection.opens.get(opened.sessionId)!
const messageId = open.openingMessageId!
preparing.release()
await (boundary === 'claimed' ? claimed.reached : injected.reached)
const agent = host.ctx.agents.get(opened.sessionId)!
await host.ctx.sessions.flush(agent.session)
await host.ctx.sessionPersistence.flush()
const pending = await host.ctx.messageDelivery.status(messageId)
// A real control drains the owner's observed transitions before checking the claim/dispatch fence.
const withdrawal = await host.ctx.messageDelivery.withdraw({ messageId, expectedRevision: pending.revision,
  operationId: operation(`blocked-withdraw-${boundary}`) as string as import('@panedesk/dsh-message-delivery').OperationId })
const deadline = performance.now() + 10000
let status = await host.ctx.messageDelivery.status(messageId)
while (boundary === 'claimed' ? status.phase !== 'claimed' : status.state !== 'injected') {
  if (performance.now() > deadline) throw new Error('Delivery did not persist the real input boundary')
  await delay(10)
  status = await host.ctx.messageDelivery.status(messageId)
}
await host.engine.drive()
const listed = await host.seats.list({})
if (listed.status !== 'listed' || !listed.sessions[0]) throw new Error('Missing live window')
const liveClose = await host.seats.close({ sessionId: opened.sessionId,
  expectedStateVersion: listed.sessions[0].stateVersion, operationId: operation(`live-close-${boundary}`) })
process.send?.({ kind: 'input-boundary', pid: process.pid, boundary, liveClose, sessionId: opened.sessionId,
  messageId, status, withdrawal, received,
  phases: agent.session.snapshotEvents().filter(event => event.type === 'agent/input/transition')
    .map(event => event.data.phase),
  userMessages: agent.session.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.id === messageId).length })
// The parent kills only this recorded child PID; graceful disposal would roll a claim back.
await new Promise<never>(() => {})
