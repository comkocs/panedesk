/** Child thresholds derive their parent definition from durable engine admission. */
import { expect } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import type { LedgerRunId } from '@panedesk/dsh-session-ledger'
import type { SessionId } from '@panedesk/dsh-session'
import type { engineFixture } from './engine-fixture.ts'
import { recordCost } from './ledger-call.ts'
import { LocalSeatService } from '../src/service.ts'

/** Check child-owned steer delivery and replay using real admission and Session creation.
 * @param f - real engine, ledger, creation and delivery providers.
 * @param parentSessionId - bound parent window.
 */
export async function checkChildContext(f: Awaited<ReturnType<typeof engineFixture>>, parentSessionId: SessionId): Promise<void> {
  const service = f.ctx.get('seats')
  const creation = f.ctx.get('sessionCreation')
  if (!(service instanceof LocalSeatService) || !creation) throw new Error('Child context providers are unavailable')
  const admitted = await f.engine.admitChild({ maxActive: 1, ticket: {
    ticketId: 'context-child' as T.ChildTicketId, parentSessionId, sequence: 0,
    requestDigest: 'context-child' as T.SeatDigest, agentPreset: f.definition.agentPreset,
    permissionRevision: 1, phase: 'queued', childSessionId: null, ownerEpoch: 'context-owner' as T.OwnerEpoch, stateVersion: 0,
  } })
  if (admitted.status !== 'admitted') throw new Error('Child capacity was not admitted')
  const sessionId = admitted.childSessionId
  const releaseBinding = f.ctx.sessionLedger.bindContext({ sessionId, rootSessionId: parentSessionId,
    runId: 'context-child-run' as LedgerRunId, nodeId: f.options.nodeId, seat: f.definition.seat,
    window: 'context child', identitySource: 'settings', accountLabel: 'test' })
  const releaseTurn = f.ctx.on('agent/turn-admitting', ({ agent }, next) => agent.id === sessionId
    ? { kind: 'defer', reason: 'Inspect child threshold delivery.' } : next())
  try {
    const result = await creation.create({ sessionId, cwd: f.options.directory, agentPreset: f.definition.agentPreset,
      selection: { provider: f.definition.provider, model: f.definition.model,
        reasoningEffort: ReasoningEffortId(f.definition.reasoningEffort) }, releasePreparation: releaseBinding })
    await f.ctx.sessions.flush(result.agent.session)
    await recordCost(f.ctx, sessionId, 'child-context-low', '0', { inputTokens: 61, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    await service.reevaluateReport(sessionId)
    const messages = () => result.agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && JSON.stringify(event.data).includes('The child context reached its limit.'))
    expect(messages()).toHaveLength(0)
    await recordCost(f.ctx, sessionId, 'child-context-high', '0', { inputTokens: 90, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    await service.reevaluateReport(sessionId)
    await service.reevaluateReport(sessionId)
    await expect.poll(() => messages().length).toBe(1)
    await f.ctx.sessions.flush(result.agent.session)
    expect(JSON.stringify((await f.ctx.sessionQuery.readSession(sessionId))?.events)).toContain('Prepare a handoff summary')
    await f.engine.releaseChild(admitted.ticket.ticketId)
    await service.reevaluateReport(sessionId)
    expect(messages()).toHaveLength(1)
  } finally { releaseBinding(); releaseTurn() }
}
