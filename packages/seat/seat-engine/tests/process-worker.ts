/** Child-only durable executor pauses at explicit parent-controlled kill barriers. */
import { Context } from '@panedesk/cordis'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { SeatEngine } from '../src/engine.ts'
import { config, definition, nodeId, projectId, sourceId, trigger } from './fixtures.ts'

const [home, target = 'none'] = process.argv.slice(2)
if (!home) throw new Error('Missing isolated home')
const root = join(home, 'physical')
await mkdir(root, { recursive: true })
async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function barrier(stage: string): Promise<void> {
  if (target !== stage) return
  process.channel?.ref()
  process.send?.({ stage, pid: process.pid })
  await new Promise<void>(() => {})
}
const ctx = new Context()
const engine = new SeatEngine(ctx, { home, nodeId, config: { ...config, ownerObserveIntervalMs: 1000000 } }, {
  seats: () => ({ resolve: () => Promise.resolve(definition()), list: () => Promise.resolve({ status: 'listed',
    sessions: [], unopenedSeats: [], complete: true, snapshotAt: new Date().toISOString() }),
  close: () => Promise.reject(new Error('Close is driven by durable provider evidence')) }),
  ledger: () => ({ snapshot: () => Promise.resolve({ asOf: 0, watermarks: {}, complete: true, rows: [] }) }),
})
const originalCommit = engine.journal.commit.bind(engine.journal)
engine.journal.commit = async (...args) => {
  const decision = await originalCommit(...args)
  for (const effect of decision?.effects ?? []) {
    if (effect.kind === 'trigger/accepted') await barrier('ingress')
    if (effect.kind === 'open/intent') await barrier('intent')
    if (effect.kind === 'open/created') await barrier('created')
    if (effect.kind === 'open/configured') {
      if (effect.data.phase === 'active') await barrier('active')
      const stage = effect.data.completedStages.at(-1)
      if (stage) await barrier(`configured-${stage}`)
    }
    if (effect.kind === 'resource/released') await barrier('release')
  }
  return decision
}
const executor: T.SeatOpenExecutor = {
  observe: async open => await exists(join(root, open.sessionId)) ? 'matching' : 'absent',
  create: async (open) => {
    await barrier('creating')
    await writeFile(join(root, open.sessionId), JSON.stringify(open), { flag: 'wx' })
    await barrier('materialized')
    return open.sessionId
  },
  configure: () => Promise.resolve(),
  opening: async (open) => {
    const path = join(home, `message-${open.openingOperationId}`)
    if (!await exists(path)) await writeFile(path, open.sessionId, { flag: 'wx' })
    await barrier('opening-accepted')
    await barrier('first-turn-running')
    return { state: 'completed', messageId: 'opening-a' as never }
  },
  owner: () => Promise.resolve('alive'), wakeSender: () => Promise.resolve('sent'),
}
engine.registerExecutor(executor)
engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null,
  callback: async (payload) => {
    const path = join(home, `callback-${payload.callbackId}`)
    if (!await exists(path)) await writeFile(path, JSON.stringify(payload), { flag: 'wx' })
    await barrier('callback-accepted')
  } })
await engine.ready()
if ((await engine.projectPolicy(projectId)).revision === 0) await engine.setProjectMode({ projectId,
  mode: 'auto', expectedRevision: 0, operationId: 'mode-a' as T.SeatOperationId })
await barrier('before-ingress')
await engine.accept(trigger())
await engine.drive()
const open = [...engine.journal.projection.opens.values()][0]
if (!open) throw new Error('Missing original intent')
const closing = join(home, 'closing')
if (target === 'closing-archived' || target === 'release' || await exists(closing)) {
  if (!await exists(closing)) await writeFile(closing, JSON.stringify({ sessionId: open.sessionId,
    phase: 'closed', reason: 'manual', stateVersion: 2, endedAt: new Date().toISOString(), reportId: null,
    selfReport: null, selfReportStatus: 'not-submitted' } satisfies T.EngineCloseData))
  await barrier('closing-archived')
  const closed: T.EngineCloseData = JSON.parse(await readFile(closing, 'utf8')) as T.EngineCloseData
  await engine.recordClosed(closed); await engine.drive()
}
const files = await readdir(home)
const result = { physical: await readdir(root), sessionId: open.sessionId, operationId: open.openingOperationId,
  phase: open.phase, pending: engine.journal.projection.pending.size, resources: engine.journal.projection.resources.size,
  messages: files.filter(name => name.startsWith('message-')), callbacks: files.filter(name => name.startsWith('callback-')),
  callbackStates: [...engine.journal.projection.callbacks.values()].map(item => item.phase) }
await writeFile(join(home, 'result.json'), JSON.stringify(result))
await engine.shutdown(); await ctx.fiber.dispose()
process.send?.({ stage: 'done', pid: process.pid })
process.disconnect?.()
