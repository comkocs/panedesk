/** Test-only Loader worker exposes committed crash barriers over IPC. */
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

const [root, stage] = process.argv.slice(2)
if (!root || !stage) throw new Error('Missing recovery arguments')
const f = await admissionHost(root)
const readyAt = performance.now()
if (stage !== 'recover') {
  f.ctx.on('seat/decision', (decision) => {
    if (!decision.effects.some(effect => effect.kind === stage)) return
    process.send?.({ kind: 'barrier', pid: process.pid })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  })
  await f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('opening') })
} else {
  const completed = Promise.withResolvers<undefined>()
  const check = () => {
    const opens = [...f.engine.journal.projection.opens.values()]
    if (opens.length === 1 && opens[0]?.phase === 'active') completed.resolve(undefined)
  }
  const off = f.ctx.on('seat/decision', check)
  const timer = setTimeout(() => { completed.reject(new Error(JSON.stringify({
    phases: [...f.engine.journal.projection.opens.values()].map(open => open.phase),
    resources: f.engine.journal.projection.resources.size,
    requests: f.adapter.requests.length,
    agents: f.ctx.agents.list().map(agent => ({ id: agent.id, status: agent.status,
      inbox: [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(item => item.id),
      events: agent.session.snapshotEvents().filter(event => event.type === 'turn/end') })),
  }))) }, 5000)
  try {
    check()
    await f.engine.drive()
    await completed.promise
    const milliseconds = performance.now() - readyAt
    const opens = [...f.engine.journal.projection.opens.values()]
    const open = opens[0]!
    const agent = f.ctx.agents.get(open.sessionId)
    if (agent) await f.ctx.sessions.flush(agent.session)
    const snapshot = await f.ctx.sessionQuery.readSession(open.sessionId)
    process.send?.({ kind: 'recovered', milliseconds, opens: opens.length,
      sessions: (await f.ctx.sessionPersistence.list()).length,
      messages: snapshot?.events.filter(event => event.type === 'user/message').length,
      accepted: f.engine.journal.projection.decisions.flatMap(decision => decision.effects)
        .filter(effect => effect.kind === 'trigger/accepted').length,
      requests: f.adapter.requests.length })
  } finally { clearTimeout(timer); off() }
}
process.on('message', (message: unknown) => {
  if (message === 'stop') void f.close().then(() => { process.disconnect?.() })
})
