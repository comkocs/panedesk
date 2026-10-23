/** Test-only Loader worker exposes committed crash barriers over IPC. */
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { digest } from '../src/store.ts'

const [root, stage, route] = process.argv.slice(2)
if (!root || !stage) throw new Error('Missing recovery arguments')
const f = await admissionHost(root)
if (route === 'frozen-route') {
  f.adapter.listModels = provider => Promise.resolve(['model-a', 'model-b', 'model-c'].map(id => ({ provider, id, name: id })))
  const saved = await f.seats.save({ definition: { ...f.definition, model: stage === 'recover' ? 'model-c' : 'model-b' },
    expectedRevision: stage === 'recover' ? 3 : 2, operationId: operation(`route-${stage}`) })
  if (saved.status !== 'saved') throw new Error(`Route update failed: ${JSON.stringify(saved)}`)
}
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
    const current = await f.seats.resolve(f.definition.seat)
    process.send?.({ kind: 'recovered', milliseconds, opens: opens.length,
      sessions: (await f.ctx.sessionPersistence.list()).length,
      messages: snapshot?.events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'message-delivery'
        && String(event.data.source.operationId) === String(digest(open.openingOperationId))).length,
      userMessages: snapshot?.events.filter(event => event.type === 'user/message').length,
      accepted: f.engine.journal.projection.decisions.flatMap(decision => decision.effects)
        .filter(effect => effect.kind === 'trigger/accepted').length,
      requests: f.adapter.requests.length,
      firstRoute: f.adapter.requests[0] === undefined ? null : {
        provider: f.adapter.requests[0].provider, model: f.adapter.requests[0].model,
        reasoningEffort: f.adapter.requests[0].reasoningEffort },
      frozenModel: open.definition?.model,
      currentModel: 'status' in current ? null : current.model,
      permission: agent === undefined ? null : f.ctx.permissionPresets.current(agent.session) })
  } finally { clearTimeout(timer); off() }
}
process.on('message', (message: unknown) => {
  if (message === 'stop') void f.close().then(() => { process.disconnect?.() })
})
