/** Observable IPC barriers over real M5 and exact Session creation. */
import { once } from 'node:events'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@panedesk/dsh-session'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { createHost } from './e2e-host.ts'

const [root, stage] = process.argv.slice(2)
if (!root || !stage) throw new Error('Recovery arguments are required')
const host = await createHost(root)
const sessionId = SessionId('seat-recovery-a')
const messageOperation = 'opening-a' as OperationId
const barrier = async (name: string) => {
  process.send?.({ stage: name, pid: process.pid })
  await new Promise<void>(() => {})
}
try {
  if (stage === 'compete') {
    process.send?.({ stage: 'ready', pid: process.pid })
    await once(process, 'message')
    try {
      const result = await host.ctx.get('sessionCreation')!.create({ sessionId, cwd: root })
      await host.ctx.sessions.flush(host.ctx.agents.get(sessionId)!.session)
      process.send?.({ stage: 'created', pid: process.pid, sessionId: result.agent.id })
    } catch (error) {
      process.send?.({ stage: 'rejected', pid: process.pid, error: error instanceof Error ? error.message : String(error) })
    }
    await new Promise<void>(() => {})
  } else if (stage === 'm5-accepted' || stage === 'first-turn') {
    await host.ctx.get('sessionCreation')!.create({ sessionId, cwd: root,
      selection: { provider: 'provider-a', model: 'model-a' } })
    const agent = host.ctx.agents.get(sessionId)!
    const accepted = Promise.withResolvers<undefined>()
    host.ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/end') process.stderr.write(JSON.stringify(event) + '\n')
    })
    if (stage === 'm5-accepted') host.ctx.on('agent/turn-admitting', () => ({ kind: 'defer', reason: 'Crash barrier' }))
    if (stage === 'first-turn') {
      const stream = host.model.stream.bind(host.model)
      host.model.stream = async function* (options) {
        await appendFile(join(root, 'external-effects.jsonl'), JSON.stringify({ effect: 'started', outcome: 'unknown' }) + '\n')
        await host.ctx.sessions.flush(agent.session)
        await accepted.promise
        await barrier('first-turn')
        yield* stream(options)
      }
    }
    const sent = await host.ctx.messageDelivery.send({ target: { sessionId }, operationId: messageOperation,
      messageClass: 'handoff', content: 'Open seat-a.', priority: 'queue' })
    await host.ctx.sessions.flush(agent.session)
    await writeFile(join(root, 'accepted.json'), JSON.stringify(sent))
    accepted.resolve(undefined)
    if (stage === 'm5-accepted') await barrier(stage)
    await new Promise<void>(() => {})
  } else {
    const accepted = JSON.parse(await readFile(join(root, 'accepted.json'), 'utf8')) as { messageId: string }
    const duplicate = await host.ctx.messageDelivery.send({ target: { sessionId }, operationId: messageOperation,
      messageClass: 'handoff', content: 'Open seat-a.', priority: 'queue' })
    const snapshot = await host.ctx.sessionQuery.readSession(sessionId)
    const sessions = await host.ctx.sessionPersistence.list()
    await writeFile(join(root, 'recovered.json'), JSON.stringify({ accepted, duplicate,
      sessions: sessions.map(item => item.header.id), events: snapshot?.events,
      requests: host.model.requests.length,
      effects: stage === 'recover-first-turn' ? await readFile(join(root, 'external-effects.jsonl'), 'utf8') : '' }))
  }
} finally { await host.close() }
process.disconnect?.()
