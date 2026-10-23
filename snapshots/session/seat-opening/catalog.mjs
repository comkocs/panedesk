/** Materialize one seat-a definition before the local seat plugin opens its catalog. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'seat-snapshot-catalog'

/** Write the catalog into this replay process home; dispose leaves the file in place. */
export function apply(ctx) {
  const root = join(process.cwd(), 'workspace-a')
  const definition = {
    schemaVersion: 1, revision: 1, seat: 'seat-a', platform: 'server', node: 'node-a', projectId: 'project-a',
    directories: [{ path: root, startup: true }], memoryDirectories: [],
    opening: { kind: 'text', text: 'Open seat-a.' }, openingInstructionFiles: [],
    agentPreset: 'standard', provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low',
    permissionPreset: 'danger-full-access', subscriptions: [], checkpointFiles: [],
    maxOpenSessions: 1, autoKeepAlive: false, maxActiveSubagents: 4, subagentContextThresholdTokens: 400000,
    rules: [], worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 },
  }
  const document = { unit: { name: 'seat_catalog', version: 1 }, global: { revision: 1, authority: 'import-source',
    definitions: [definition], operations: {}, authorizations: [] }, tables: {} }
  const ready = mkdir(join(process.cwd(), '.panedesk', 'storages'), { recursive: true }).then(() =>
    writeFile(join(process.cwd(), '.panedesk', 'storages', 'seat_catalog.json'), `${JSON.stringify(document, null, 2)}\n`))
  ctx.effect(() => {
    const task = ready
    return async () => { await task }
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'seat_open') return next()
    const completed = Promise.withResolvers()
    const responded = new Set()
    let sessionId
    const settle = () => {
      if (sessionId && responded.has(sessionId)) completed.resolve()
    }
    const off = ctx.on('message/state', event => {
      if (event.data.state === 'responded') responded.add(event.data.targetSessionId)
      settle()
    })
    const timer = setTimeout(() => completed.reject(new Error('Seat opening did not complete')), 10000)
    try {
      const [result] = await Promise.all([next().then(result => {
        if (result.isError) throw new Error('Seat opening failed')
        const opened = JSON.parse(result.value)
        if (opened.status !== 'opened') throw new Error('Seat opening failed')
        sessionId = opened.sessionId
        settle()
        return result
      }), completed.promise])
      await ctx.get('seatEngine').drive()
      return result
    } finally { clearTimeout(timer); off() }
  })
}
