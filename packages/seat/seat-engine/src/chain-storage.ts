/** Required remote admission evidence is validated before any legacy action is projected. */
import { NODE_WORK_CHAIN_CAPABILITY, type EngineEffectBase, type NodeWorkChainAcceptedEffect,
  type NodeWorkChainAcceptedData } from '@panedesk/dsh-seat'
import { digest, EngineError } from './journal.ts'
import { validEffect } from './validation.ts'
import type { AuthorizationDecision } from './authorization-storage.ts'

/** Required route facts retain ordinary engine identity fields without widening shared effects. */
export type ChainAcceptedEffect = NodeWorkChainAcceptedEffect & EngineEffectBase
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(id) && new Set(value).size === value.length
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const timestamp = (value: unknown) => id(value) && Number.isFinite(Date.parse(value))
const fields = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const same = (left: unknown, right: unknown) => digest(left) === digest(right)
const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen']

/** Validate the complete retained route, snapshot, reservation and original business identity.
 * @param value - Untrusted journal data, never a process-local grant.
 * @returns Whether the full accepted record can participate in replay.
 */
export function validChainAccepted(value: unknown): value is NodeWorkChainAcceptedData {
  if (!object(value) || !fields(value, ['capability', 'route', 'openingContext', 'expectedSeatRevision',
    'authorizationRef', 'payloadDigest', 'operationKey', 'trigger']) || value.capability !== NODE_WORK_CHAIN_CAPABILITY
    || !positive(value.expectedSeatRevision) || !id(value.authorizationRef) || !id(value.payloadDigest)) return false
  const route = value.route, context = value.openingContext, key = value.operationKey
  if (!object(route) || !object(context) || !object(key)
    || !fields(key, ['sourceNodeId', 'principalId', 'sourceId', 'ownerEpoch', 'method', 'operationId'])
    || !Object.values(key).every(id) || !methods.includes(String(key.method))
    || !fields(route, ['sourceId', 'sourceOwnerNodeId', 'ownerEpoch', 'triggerId', 'originalOperationId',
      'targetNodeId', 'snapshotDigest', 'callbackPath', 'modeCeiling'])
    || !['sourceId', 'sourceOwnerNodeId', 'ownerEpoch', 'originalOperationId', 'targetNodeId', 'snapshotDigest'].every(name => id(route[name]))
    || !(route.triggerId === null || id(route.triggerId))
    || key.sourceId !== route.sourceId
    || key.ownerEpoch !== route.ownerEpoch || key.operationId !== route.originalOperationId
    || !fields(context, ['snapshot', 'scopeReservation', 'openingMode'], ['staffBinding'])
    || !['auto', 'prefill'].includes(String(context.openingMode))) return false
  const snapshot = context.snapshot, scope = context.scopeReservation, ceiling = route.modeCeiling, path = route.callbackPath
  if (!object(snapshot) || !object(scope) || !object(ceiling) || !object(path)
    || !fields(snapshot, ['reference', 'text', 'digest', 'revision', 'taskIds', 'scopeEvidence'])
    || typeof snapshot.text !== 'string' || !id(snapshot.digest) || !id(snapshot.revision) || !ids(snapshot.taskIds)
    || !Array.isArray(snapshot.scopeEvidence) || !object(snapshot.reference)
    || !fields(snapshot.reference, ['providerId', 'reference', 'revision']) || !Object.values(snapshot.reference).every(id)
    || snapshot.reference.revision !== snapshot.revision || digest(snapshot.text) !== snapshot.digest
    || snapshot.digest !== route.snapshotDigest
    || !fields(scope, ['reservationId', 'sourceId', 'sourceOwnerNodeId', 'ownerEpoch', 'operationId', 'taskIds', 'snapshotDigest', 'policyRevision'])
    || !id(scope.reservationId) || !ids(scope.taskIds) || !revision(scope.policyRevision)
    || !same([...scope.taskIds].sort(), [...snapshot.taskIds].sort())
    || scope.sourceId !== route.sourceId || scope.sourceOwnerNodeId !== route.sourceOwnerNodeId
    || scope.ownerEpoch !== route.ownerEpoch || scope.operationId !== route.originalOperationId || scope.snapshotDigest !== snapshot.digest
    || !fields(ceiling, ['mode', 'policy']) || !['off', 'remind', 'auto'].includes(String(ceiling.mode)) || !object(ceiling.policy)
    || !fields(ceiling.policy, ['sourceId', 'projectId', 'revision'], ['ruleId']) || ceiling.policy.sourceId !== route.sourceId
    || !id(ceiling.policy.projectId) || !revision(ceiling.policy.revision)
    || ceiling.policy.ruleId !== undefined && !id(ceiling.policy.ruleId)) return false
  if (path.kind === 'source') {
    if (!fields(path, ['kind', 'sourceId']) || path.sourceId !== route.sourceId) return false
  } else if (path.kind === 'opening-context') {
    if (!fields(path, ['kind', 'reference', 'operationId']) || !same(path.reference, snapshot.reference)
      || path.operationId !== route.originalOperationId) return false
  } else return false
  for (const evidence of snapshot.scopeEvidence) {
    if (!object(evidence) || !snapshot.taskIds.includes(String(evidence.taskId))) return false
    if (evidence.status === 'unknown') {
      if (!fields(evidence, ['status', 'taskId', 'reason', 'alternative']) || !id(evidence.reason) || evidence.alternative !== 'serial') return false
    } else if (evidence.status === 'known') {
      if (!fields(evidence, ['status', 'taskId', 'revision', 'repositoryId', 'baseRevision', 'entries', 'patternSyntax', 'caseSensitive'])
        || !['revision', 'repositoryId', 'baseRevision'].every(name => id(evidence[name]))
        || evidence.patternSyntax !== 'literal' && evidence.patternSyntax !== 'glob-v1' || typeof evidence.caseSensitive !== 'boolean'
        || !Array.isArray(evidence.entries) || !evidence.entries.every(entry => object(entry)
          && fields(entry, ['kind', 'path', 'access']) && ['file', 'directory', 'pattern'].includes(String(entry.kind))
          && id(entry.path) && ['read', 'write'].includes(String(entry.access)))) return false
    } else return false
  }
  if (context.staffBinding !== undefined) {
    const staff = context.staffBinding
    if (!object(staff) || !fields(staff, ['staffId', 'seat', 'taskIds', 'evidenceRef', 'revision', 'verifiedAt'])
      || !['staffId', 'seat', 'evidenceRef', 'revision'].every(name => id(staff[name])) || !timestamp(staff.verifiedAt)
      || !ids(staff.taskIds) || !same([...staff.taskIds].sort(), [...snapshot.taskIds].sort())) return false
  }
  if (key.method === 'engine.acceptFrozen') {
    if (!object(value.trigger) || value.trigger.triggerId !== route.triggerId || value.trigger.sourceId !== route.sourceId
      || value.trigger.callbackRef !== route.sourceId || value.trigger.projectId !== ceiling.policy.projectId) return false
  } else if (value.trigger !== null || route.triggerId !== null) return false
  return true
}

/** Verify required capability and same-frame authorization before decoding legacy effects.
 * @param decision - Checksum-verified expanded decision.
 */
export function validateChainFrame(decision: AuthorizationDecision): void {
  const routes = decision.effects.filter((effect): effect is ChainAcceptedEffect => effect.kind === 'node-route/accepted')
  if (!routes.length) {
    if (decision.requiredCapabilities !== undefined) throw new EngineError('engine-store-corrupt', 'Unexpected required engine capability')
    return
  }
  if (!same(decision.requiredCapabilities ?? [], [NODE_WORK_CHAIN_CAPABILITY])) {
    throw new EngineError('engine-store-corrupt', 'Required route capability is missing')
  }
  for (const effect of routes) {
    if (!validChainAccepted(effect.data) || effect.operationId !== effect.data.operationKey.operationId
      || decision.nodeId !== effect.data.route.targetNodeId) throw new EngineError('engine-store-corrupt', 'Invalid required route evidence')
    const data = effect.data
    const authorization = decision.effects.find(item => item.kind === 'authorization/checked'
      && item.data.authorizationId === data.authorizationRef)
    if (authorization?.kind !== 'authorization/checked' || authorization.data.kind !== 'node-delegation'
      || authorization.data.decision !== 'allowed' || authorization.data.requestDigest !== data.payloadDigest
      || authorization.data.operationId !== data.operationKey.operationId
      || authorization.data.principalId !== data.operationKey.principalId
      || authorization.data.nodeId !== decision.nodeId || authorization.data.seat !== effect.seat
      || data.openingContext.snapshot.taskIds.some(task => !authorization.data.taskIds.includes(task))) {
      throw new EngineError('engine-store-corrupt', 'Required route authorization does not match')
    }
    const intent = decision.effects.find(item => (item.kind === 'trigger/accepted' || item.kind === 'trigger/coalesced')
      && item.operationId === effect.operationId && item.seat === effect.seat)
    if (!intent || (intent.kind !== 'trigger/accepted' && intent.kind !== 'trigger/coalesced')
      || !validEffect(intent.kind, intent.data) || !same(intent.data.pending.frozenOpen?.nodeWorkChain ?? null, data)
      || data.trigger !== null && !same(intent.data.trigger, data.trigger)) {
      throw new EngineError('engine-store-corrupt', 'Required route has no matching frozen intent')
    }
  }
}
