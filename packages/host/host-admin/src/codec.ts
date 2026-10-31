/** Administrative frames validate identity separately from provider-owned operation semantics. */
import { decodeSeatRequest, decodeSeatResult } from '@panedesk/dsh-sdk-protocol'
import { HOST_ADMIN_METHODS, HOST_ADMIN_VERSION, HOST_ADMIN_ERROR_CODES, HOST_ADMIN_DETAIL_CODES } from './index.ts'
import type { HostAdminRequest, HostAdminResponse } from './index.ts'
import { object, identifier, digest } from './json.ts'
import { SEAT_ENGINE_EVENT_NAMES, type EngineEventKind } from '@panedesk/dsh-seat'
import { validEffect, validAuthorization } from '@panedesk/dsh-seat-engine'

/** Decode only the frozen administrative method set.
 * @param value - Bounded JSON request.
 * @returns Validated frame; unknown fields cannot self-assign authority.
 */
export function decodeRequest(value: unknown): HostAdminRequest {
  if (!object(value) || value.version !== HOST_ADMIN_VERSION || !identifier(value.requestId)
    || !identifier(value.processEpoch) || !identifier(value.nonce) || typeof value.method !== 'string'
    || !HOST_ADMIN_METHODS.some(method => method === value.method)
    || Object.keys(value).some(key => !['version', 'requestId', 'processEpoch', 'nonce', 'method', 'params'].includes(key))) {
    throw new Error('Administration frame rejected')
  }
  switch (value.method) {
    case 'source.operations': {
      const params = value.params
      if (!object(params) || Object.keys(params).some(key => key !== 'limit')
        || params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 200)) {
        throw new Error('Source operations request rejected')
      }
      break
    }
    case 'source.abandon':
    case 'source.resend': {
      const params = value.params
      if (!object(params) || Object.keys(params).some(key => !['operationId', 'key', 'reason'].includes(key))
        || typeof params.operationId !== 'string' || params.operationId.trim().length === 0
        || !boundedString(params.key, 512) || params.key.length === 0
        || !boundedString(params.reason, 500) || params.reason.length === 0) throw new Error('Source write request rejected')
      break
    }
    case 'node.status': decodeSeatRequest('seats/nodeStatus', value.params); break
    case 'node.rebuild': {
      if (!object(value.params) || Object.keys(value.params).some(key => key !== 'peerNodeId')
        || value.params.peerNodeId !== undefined && !identifier(value.params.peerNodeId)) throw new Error('Node rebuild request rejected')
      break
    }
    case 'engine.pending': decodeSeatRequest('seats/pending', value.params); break
    case 'engine.approve': decodeSeatRequest('seats/approve', value.params); break
    case 'engine.cancel': decodeSeatRequest('seats/cancel', value.params); break
    case 'engine.callbackResolve': {
      const params = value.params
      if (!object(params) || Object.keys(params).some(key => !['callbackId', 'action', 'expectedAttempt'].includes(key))
        || !identifier(params.callbackId) || params.action !== 'resume' && params.action !== 'abandon'
        || !Number.isSafeInteger(params.expectedAttempt) || Number(params.expectedAttempt) < 0) {
        throw new Error('Callback resolution request rejected')
      }
      break
    }
    case 'engine.operation': decodeSeatRequest('seats/operation', value.params); break
    case 'engine.query': {
      const params = value.params
      if (!object(params) || !Number.isSafeInteger(params.limit) || Number(params.limit) < 1
        || Object.keys(params).some(key => !['limit', 'cursor', 'authorizationCursor', 'kind', 'nodeId', 'seat', 'kinds', 'from', 'to', 'taskId'].includes(key))
        || Object.entries(params).some(([key, entry]) => !['limit', 'cursor', 'authorizationCursor', 'kinds'].includes(key) && !identifier(entry))
        || params.kind !== undefined && (typeof params.kind !== 'string'
          || !['human', 'engine', 'model-tool-call', 'local-operator', 'node-delegation', 'plugin'].includes(params.kind))
        || (params.kinds !== undefined && (!Array.isArray(params.kinds) || !params.kinds.every(identifier)))) {
        throw new Error('Administration query rejected')
      }
      for (const cursor of [params.cursor, params.authorizationCursor]) {
        if (cursor !== undefined && !validCursor(cursor)) throw new Error('Administration cursor rejected')
      }
      break
    }
  }
  return value as HostAdminRequest
}

/** Validate response correlation and provider result discrimination.
 * @param value - Bounded response or durable replay.
 * @param request - Original validated request.
 * @returns Correlated response; malformed replies remain unknown outcomes.
 */
export function decodeResponse(value: unknown, request: HostAdminRequest): HostAdminResponse {
  if (!object(value) || value.version !== HOST_ADMIN_VERSION || value.requestId !== request.requestId || value.method !== request.method) {
    throw new Error('Administration response identity rejected')
  }
  if (request.method === 'source.operations' || request.method === 'source.abandon' || request.method === 'source.resend') {
    const allowed = value.status === 'ok' ? ['version', 'requestId', 'method', 'status', 'result']
      : ['version', 'requestId', 'method', 'status', 'code', 'detail', 'reason', 'operationId']
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Source response fields rejected')
  }
  if (value.status !== 'ok') {
    if (!['rejected', 'unavailable', 'uncertain'].includes(String(value.status))
      || !HOST_ADMIN_ERROR_CODES.some(code => code === value.code) || typeof value.reason !== 'string'
      || value.detail !== undefined && !HOST_ADMIN_DETAIL_CODES.some(code => code === value.detail)) {
      throw new Error('Administration failure rejected')
    }
    return value as HostAdminResponse
  }
  switch (request.method) {
    case 'source.operations': {
      const result = value.result
      if (!object(result) || Object.keys(result).some(key => key !== 'items') || !Array.isArray(result.items)
        || result.items.length > 200 || !result.items.every(validSourceItem)) throw new Error('Source operations result rejected')
      break
    }
    case 'source.abandon':
    case 'source.resend': {
      const result = value.result
      if (!object(result) || Object.keys(result).some(key => !['status', 'code', 'reason', 'generation', 'effect'].includes(key))
        || result.status !== 'ok' && result.status !== 'rejected'
        || result.code !== undefined && !boundedString(result.code, 512)
        || result.reason !== undefined && !boundedString(result.reason, 512)
        || result.effect !== undefined && (result.effect !== 'none' || result.status !== 'rejected')
        || result.generation !== undefined && (!Number.isSafeInteger(result.generation) || Number(result.generation) < 1)) {
        throw new Error('Source write result rejected')
      }
      break
    }
    case 'node.status': decodeSeatResult('seats/nodeStatus', value.result); break
    case 'node.rebuild': {
      const result = value.result
      if (!object(result) || Object.keys(result).some(key => key !== 'status')
        || result.status !== 'rebuilt' && result.status !== 'unavailable') throw new Error('Node rebuild result rejected')
      break
    }
    case 'engine.pending':
      if (object(value.result) && value.result.status === 'rejected') decodeSeatResult('seats/approve', value.result)
      else decodeSeatResult('seats/pending', value.result)
      break
    case 'engine.approve': decodeSeatResult('seats/approve', value.result); break
    case 'engine.cancel': decodeSeatResult('seats/cancel', value.result); break
    case 'engine.callbackResolve': {
      const result = value.result
      if (!object(result)) throw new Error('Callback resolution result rejected')
      if (result.status === 'ok') {
        if (Object.keys(result).some(key => !['status', 'callbackId', 'phase', 'attempt'].includes(key))
          || result.callbackId !== request.params.callbackId || !Number.isSafeInteger(result.attempt) || Number(result.attempt) < 0
          || !['pending', 'retry-due', 'paused', 'delivered', 'abandoned'].includes(String(result.phase))) {
          throw new Error('Callback resolution state rejected')
        }
      } else if (result.status !== 'rejected' || Object.keys(result).some(key => !['status', 'code'].includes(key))
        || !['callback-unknown', 'callback-not-paused', 'callback-attempt-conflict', 'callback-resolution-unauthorized'].includes(String(result.code))) {
        throw new Error('Callback resolution refusal rejected')
      }
      break
    }
    case 'engine.operation':
      decodeSeatResult('seats/operation', value.result)
      if (object(value.result)) validateProgress(value.result)
      break
    case 'engine.query':
      if (object(value.result) && value.result.status === 'rejected') {
        decodeSeatResult('seats/approve', value.result)
        break
      }
      if (!object(value.result) || !Array.isArray(value.result.effects) || typeof value.result.complete !== 'boolean'
        || !Number.isSafeInteger(value.result.watermark) || Number(value.result.watermark) < 0
        || value.result.effects.length > request.params.limit) throw new Error('Administration query result rejected')
      if (value.result.authorizations !== undefined) {
        const page = value.result.authorizations
        if (!object(page) || !Array.isArray(page.facts) || page.facts.length > request.params.limit
          || !page.facts.every(validAuthorization) || typeof page.complete !== 'boolean'
          || !Number.isSafeInteger(page.watermark) || Number(page.watermark) < 0
          || !['none', 'legacy-unknown'].includes(String(page.legacyAttribution))
          || page.nextCursor !== undefined && (!validCursor(page.nextCursor)
            || Number(page.nextCursor.sequence) > Number(page.watermark)
            || request.params.nodeId !== undefined && page.nextCursor.nodeId !== request.params.nodeId)) {
          throw new Error('Administration authorization page rejected')
        }
      }
      for (const effect of value.result.effects) {
        if (!object(effect) || !identifier(effect.eventId) || typeof effect.kind !== 'string'
          || !Object.hasOwn(SEAT_ENGINE_EVENT_NAMES, effect.kind) || !object(effect.data)
          || !validEffect(effect.kind as EngineEventKind, effect.data)
          || ['seat', 'sessionId', 'taskId', 'triggerId', 'operationId', 'causedBy'].some(key =>
            effect[key] !== undefined && !identifier(effect[key]))) throw new Error('Administration query effect rejected')
        const data = effect.data
        if (['sessionId', 'seat', 'operationId'].some(key => effect[key] !== undefined
          && data[key] !== undefined && effect[key] !== data[key])
          || (object(data.payload) && digest(data.payload) !== data.payloadDigest)) throw new Error('Administration query effect mismatch')
      }
      if (value.result.nextCursor !== undefined) {
        const cursor = value.result.nextCursor
        if (!object(cursor) || !identifier(cursor.nodeId) || !Number.isSafeInteger(cursor.sequence)
          || Number(cursor.sequence) < 0 || Number(cursor.sequence) > Number(value.result.watermark)
          || !Number.isSafeInteger(cursor.effectIndex) || Number(cursor.effectIndex) < 0
          || (request.params.nodeId !== undefined && cursor.nodeId !== request.params.nodeId)) {
          throw new Error('Administration result cursor rejected')
        }
      }
      break
  }
  return value as HostAdminResponse
}
function boundedString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit
}
function validSourceItem(value: unknown): boolean {
  return object(value) && Object.keys(value).every(key => ['key', 'state', 'eventId', 'target', 'since', 'ticket', 'detail', 'observation'].includes(key))
    && (value.state === 'awaiting-manual' || value.state === 'parked-none')
    && ['key', 'eventId', 'target', 'since'].every(key => boundedString(value[key], 512))
    && typeof value.since === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.since)
    && Number.isFinite(Date.parse(value.since))
    && (value.ticket === undefined || boundedString(value.ticket, 512))
    && (value.detail === undefined || boundedString(value.detail, 2000))
    && (value.observation === undefined || validSourceObservation(value.observation))
}
function validSourceObservation(value: unknown): boolean {
  if (!object(value) || Object.keys(value).some(key => !['source', 'parkingCode', 'firstAttemptAt', 'lastAttemptAt', 'count',
    'attemptsAtLeast', 'latestReason'].includes(key))) return false
  return boundedString(value.source, 512) && boundedString(value.parkingCode, 512)
    && [value.firstAttemptAt, value.lastAttemptAt].every(time => time === null
      || typeof time === 'string' && time.length <= 64 && Number.isFinite(Date.parse(time)))
    && (value.count === null || Number.isSafeInteger(value.count) && Number(value.count) >= 0)
    && typeof value.attemptsAtLeast === 'boolean' && (value.latestReason === null || boundedString(value.latestReason, 2000))
}
function validCursor(value: unknown): value is Record<string, unknown> {
  return object(value) && identifier(value.nodeId) && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0
    && Number.isSafeInteger(value.effectIndex) && Number(value.effectIndex) >= 0
    && Object.keys(value).every(key => ['nodeId', 'sequence', 'effectIndex'].includes(key))
}
function validateProgress(result: Record<string, unknown>): void {
  const approval = result.approval, progress = result.progress
  if (approval !== undefined && (!object(approval) || !identifier(approval.queueItemId)
    || !Number.isSafeInteger(approval.stateVersion) || Number(approval.stateVersion) < 0)) {
    throw new Error('Administration approval projection rejected')
  }
  if (progress === undefined) return
  if (!object(progress)) throw new Error('Administration progress rejected')
  if (progress.kind === 'cancelled') return
  if (progress.kind === 'open' && identifier(progress.sessionId)
    && ['intent', 'creating', 'created', 'configuring', 'opening-pending', 'active', 'opening-failed'].includes(String(progress.phase))) return
  if (progress.kind === 'pending' && ['approval', 'project-off', 'time-window', 'node-capacity', 'seat-capacity', 'exclusive-tag',
    'budget-full', 'budget-unverifiable', 'provider-unavailable'].includes(String(progress.reason))
    && Array.isArray(progress.blockedBy) && progress.blockedBy.every(identifier)) return
  throw new Error('Administration progress rejected')
}
