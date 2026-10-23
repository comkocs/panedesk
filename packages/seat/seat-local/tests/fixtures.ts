import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import StorageService from '@panedesk/dsh-storage'
import { DomainFacility } from '@panedesk/dsh-storage-domain'
import { JsonStorageBackend } from '@panedesk/dsh-storage-json'
import type { SeatDefinition, SeatNodeId, SeatName, SeatOperationId, SeatProjectId } from '@panedesk/dsh-seat'
import { SeatStore } from '../src/store.ts'
import type { DefinitionCatalogs } from '../src/schema.ts'

export const seat = 'seat-a' as SeatName
export const nodeId = 'node-a' as SeatNodeId
export const operation = (value: string) => value as SeatOperationId
export function definition(root: string, overrides: Partial<SeatDefinition> = {}): SeatDefinition {
  return { schemaVersion: 1, revision: 1, seat, platform: 'server', node: 'node-a', projectId: 'project-a' as SeatProjectId,
    directories: [{ path: root, startup: true }], memoryDirectories: [], opening: { kind: 'text', text: 'Open {{seat}} on {{date}} for {{taskId}}.' },
    openingInstructionFiles: [], agentPreset: 'agent-a', provider: 'provider-a', model: 'model-a', reasoningEffort: 'effort-a',
    permissionPreset: 'permission-a', subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, maxActiveSubagents: 4,
    subagentContextThresholdTokens: 400000, rules: [], worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 }, ...overrides }
}
export function catalogs(root: string): DefinitionCatalogs {
  return { nodeId, nodeAliases: { 'node-a': nodeId }, defaults: definition(root), validateOptions: async () => null }
}
export async function storeFixture() {
  const root = await mkdtemp(join(process.cwd(), '.seat-test-'))
  const ctx = new Context()
  const backend = new JsonStorageBackend(root)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  try {
    await ctx.plugin(StorageService)
    ctx.storage.backend.register('json', backend)
    const store = await SeatStore.open(facility, root)
    return { root, ctx, backend, facility, store,
      close: async () => {
        try { await store.close(); await facility.closeAll(); await backend.close() }
        finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
      } }
  } catch (error) {
    try { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
    throw error
  }
}
