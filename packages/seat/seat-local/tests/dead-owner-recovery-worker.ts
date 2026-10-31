/** Real Loader worker retains an acknowledged opening across an owner process death. */
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

const [root, stage] = process.argv.slice(2)
if (!root || !stage) throw new Error('Missing owner recovery arguments')
const f = await admissionHost(root)
// The fixture constructs SeatEngine directly; retain its production turn-admission fence.
f.ctx.on('agent/turn-admitting', async ({ agent }, next) => {
  const upstream = await next()
  if (upstream.kind !== 'allow') return upstream
  const admission = await f.engine.admitTurn(agent.id)
  return admission.status === 'allow' ? upstream : { kind: 'defer', reason: admission.reason }
})
const sourceId = 'source-a' as T.SeatSourceId
const second = 'seat-b' as T.SeatName
f.engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
if (stage === 'held') {
  let revision = (await f.seats.definitions({})).revision
  for (const seat of [f.definition.seat, second]) {
    const saved = await f.seats.save({ definition: { ...f.definition, seat, rules: [{
      id: 'rule-a' as T.SeatRuleId, enabled: true, trigger: { kind: 'external', sourceId },
      timeWindows: [], exclusiveTags: ['resource-a'],
    }] }, expectedRevision: revision++, operationId: operation(`save-${seat}`) })
    if (saved.status !== 'saved') throw new Error(JSON.stringify(saved))
  }
  await f.engine.setProjectMode({ projectId: f.definition.projectId, mode: 'auto', expectedRevision: 0,
    operationId: operation('mode-a') })
  for (const seat of [f.definition.seat, second]) await f.engine.accept({
    triggerId: seat as string as T.TriggerId, sourceId, eventId: seat as string as T.SourceEventId,
    kind: 'external', evidence: { kind: 'external', eventType: 'event-a' }, seat,
    projectId: f.definition.projectId, receivedAt: new Date().toISOString(),
    dataDigest: 'digest-a' as T.SeatDigest, data: null, callbackRef: sourceId,
  })
  await f.engine.drive()
  const open = [...f.engine.journal.projection.opens.values()][0]
  if (!open || open.phase !== 'opening-pending' || open.openingMessageId === null) {
    throw new Error(`Expected acknowledged pending opening: ${JSON.stringify(open)}`)
  }
  process.send?.({ kind: 'held', pid: process.pid, sessionId: open.sessionId, phase: open.phase })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
} else {
  const readyAt = (await f.engine.nodeStatus()).readyAt
  if (!readyAt) throw new Error('Engine readiness is unavailable')
  const completed = Promise.withResolvers<undefined>()
  const check = () => {
    if ([...f.engine.journal.projection.opens.values()].some(open => open.binding.kind === 'seat'
      && open.binding.seat === second && open.phase === 'active')) completed.resolve(undefined)
  }
  const off = f.ctx.on('seat/decision', check)
  const timer = setTimeout(() => { completed.reject(new Error(JSON.stringify({
    phases: [...f.engine.journal.projection.opens.values()].map(open => open.phase),
    resources: f.engine.journal.projection.resources.size, pending: f.engine.journal.projection.pending.size,
  }))) }, 5000)
  try {
    check()
    await f.engine.drive()
    await completed.promise
    const effects = f.engine.journal.projection.decisions.flatMap(decision => decision.effects)
    const releases = effects.filter(effect => effect.kind === 'resource/released').map(effect => effect.data)
    process.send?.({ kind: 'released', milliseconds: Date.now() - Date.parse(readyAt), releases,
      opens: f.engine.journal.projection.opens.size, sessions: (await f.ctx.sessionPersistence.list()).length,
      agents: f.ctx.agents.list().length, pending: f.engine.journal.projection.pending.size,
      closed: [...f.engine.journal.projection.closed.values()].map(close => ({ sessionId: close.sessionId, reason: close.reason })),
      archived: f.ctx.workspaceRegistry.archivedSessionIds,
      requests: f.adapter.requests.length })
  } finally { clearTimeout(timer); off() }
  process.on('message', (message: unknown) => {
    if (message === 'stop') void f.close().then(() => { process.disconnect?.() })
  })
}
