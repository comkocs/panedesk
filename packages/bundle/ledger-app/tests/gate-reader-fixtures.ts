import type { EngineEffect, GateDefinition, SeatEngineConfig, SeatNodeId } from '@panedesk/dsh-seat'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const nodeId = 'node-a' as SeatNodeId
export const engineConfig: SeatEngineConfig = {
  nodeName: 'node-a', nodeAliases: { local: nodeId }, dedupWindowMs: 1000,
  maxDecisionBytes: 200000, maxSourceBytes: 20000, maxBatchSeats: 10, maxCauseDepth: 8, budgetTimeZone: 'UTC',
  callbackTimeoutMs: 1000, callbackMaxResponseBytes: 1000, callbackRetryInitialMs: 1, callbackRetryMaxMs: 100,
  ownerObserveIntervalMs: 1000, ownerReleaseBudgetMs: 2000, queueWakeBudgetMs: 1000,
}
export const definition: GateDefinition = {
  id: 'gate-a' as GateDefinition['id'], name: 'gate-a', hook: 'before-open',
  criterion: { type: 'worktree-client' as GateDefinition['criterion']['type'], parameters: {} },
  alternative: 'Use a light worktree.', expiresAt: null, enabled: true, revision: 1, order: 0,
}
export function hit(count: number, policy: GateDefinition = definition): Extract<EngineEffect, { kind: 'gate/hit' }> {
  return { eventId: `hit-${policy.id}-${policy.revision}-${count}` as EngineEffect['eventId'], kind: 'gate/hit', data: {
    definition: policy,
    context: { callId: `call-${count}` as never, operationId: `operation-${count}` as never, nodeId,
      seat: 'seat-a' as never, sessionId: null, observedAt: '2026-01-01T00:00:00Z',
      hook: 'before-open', cwd: '/workspace', candidateSeats: [],
      worktreeFacts: { event: 'register', requestedKind: 'client', clientTreeCount: count, clientTreeLimit: 2,
        authorizedForce: false, alternative: 'Use a light worktree.', mature: false } },
    result: { gateId: policy.id, revision: policy.revision, hitCount: count, expiresAt: policy.expiresAt,
      audit: 'recorded', outcome: 'deny', reason: { code: 'worktree-client-limit', message: 'Client tree limit reached.',
        alternative: policy.alternative, retryable: false, effectState: 'none' }, alternative: policy.alternative },
  } }
}
export async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      result[entry.name + '/'] = ''
      for (const [name, bytes] of Object.entries(await inventory(join(root, entry.name)))) result[entry.name + '/' + name] = bytes
    } else result[entry.name] = (await readFile(join(root, entry.name))).toString('base64')
  }
  return result
}
