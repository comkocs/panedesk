/** Isolated deployment values for the seat profile. */
import type * as T from '@panedesk/dsh-seat'
import type { LocalSeatOptions } from '@panedesk/dsh-seat-local'

export function deployment(root: string, nodeId: T.SeatNodeId) {
  const definition: T.SeatDefinition = {
    schemaVersion: 1, revision: 1, seat: 'seat-a' as T.SeatName, platform: 'server', node: 'node-a',
    projectId: 'project-a' as T.SeatProjectId, directories: [{ path: root, startup: true }], memoryDirectories: [],
    opening: { kind: 'text', text: 'Open {{seat}}.' }, openingInstructionFiles: [], agentPreset: 'agent-a',
    provider: 'provider-a', model: 'model-a', reasoningEffort: 'effort-a', permissionPreset: 'permission-a',
    subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, autoKeepAlive: false, maxActiveSubagents: 4,
    subagentContextThresholdTokens: 400000, rules: [],
    worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 },
  }
  const local: LocalSeatOptions = { directory: root, nodeId, nodeName: 'node-a', nodeAliases: { 'node-a': nodeId },
    defaults: definition, maxSourceBytes: 65536, maxPlans: 20, maxOpeningBytes: 65536, maxBatchSeats: 10,
    pageSize: 100, transactionRetries: 10, maxConfirmations: 10, closedSuffix: ' closed' }
  const engine = { home: root, nodeName: 'node-a', nodeAliases: local.nodeAliases, dedupWindowMs: 1000,
    maxDecisionBytes: 200000, maxSourceBytes: 65536, maxBatchSeats: 10, maxCauseDepth: 8, budgetTimeZone: 'UTC',
    callbackTimeoutMs: 1000, callbackMaxResponseBytes: 1000, callbackRetryInitialMs: 1, callbackRetryMaxMs: 100,
    ownerObserveIntervalMs: 1000, ownerReleaseBudgetMs: 2000, queueWakeBudgetMs: 1000 }
  return { local, engine, definition }
}

export const operation = (value: string) => value as T.SeatOperationId
