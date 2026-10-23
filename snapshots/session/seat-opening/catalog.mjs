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
}
