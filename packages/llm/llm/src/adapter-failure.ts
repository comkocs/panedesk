/**
 * Normalization for values thrown by a final LLM adapter boundary.
 *
 * @module @panedesk/dsh-llm/adapter-failure
 */

import { HarnessError } from './error.ts'
import type { LlmFailure } from './types.ts'

/** Redact only the configured credential and long sk-prefixed keys before truncation or persistence.
 * @param text - provider-owned diagnostic text.
 * @param apiKey - captured configured credential; omitted when none is configured.
 * @returns diagnostic text with credential values removed.
 */
export function redactLlmDiagnostic(text: string, apiKey?: string): string {
  return (apiKey ? text.replaceAll(apiKey, '***') : text).replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
}

/** Render provider facts without losing an observed HTTP status.
 * @param failure - serializable provider failure with an already redacted message.
 * @returns readable status and provider diagnostic.
 */
export function formatLlmFailure(failure: LlmFailure): string {
  const message = redactLlmDiagnostic(failure.message)
  return failure.status === undefined || message.startsWith(`HTTP ${failure.status}`)
    ? message : `HTTP ${failure.status}: ${message}`
}

/**
 * Detach serializable provider facts from a value thrown by an adapter.
 * @param value - arbitrary value thrown during adapter dispatch or iteration.
 * @returns immutable provider-neutral facts suitable for a terminal finish chunk.
 * @internal
 */
export function normalizeLlmFailure(value: unknown): LlmFailure {
  const error = value instanceof Error
    ? value
    : new HarnessError(thrownMessage(value), 'UNKNOWN', { cause: value })
  // Cross-package copies preserve own data but not class identity. Trust the
  // carried facts only when both own properties agree after validation.
  const carried = ownFailureSnapshot(error)
  if (carried !== undefined && carried.code === ownErrorCode(error)) return carried
  return Object.freeze({
    message: redactLlmDiagnostic(errorMessage(error)),
    code: harnessErrorCode(error),
  })
}

/** Render a non-Error throw without letting hostile coercion escape normalization. */
function thrownMessage(value: unknown): string {
  try {
    const message = String(value)
    return message.length > 0 ? message : 'LLM adapter failed'
  } catch (_hostileThrownValue) {
    return 'LLM adapter failed'
  }
}

/** Read a foreign error's own data-backed `code` without invoking accessors. */
function ownErrorCode(error: Error): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error: Error): LlmFailure | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'failure')
    return descriptor !== undefined && 'value' in descriptor
      ? failureSnapshot(descriptor.value)
      : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

/** Validate and detach an arbitrary serializable failure payload. */
function failureSnapshot(value: unknown): LlmFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const candidate = value as Partial<LlmFailure>
    const message = candidate.message
    const code = candidate.code
    const status = candidate.status
    const providerRetryAfterMs = candidate.providerRetryAfterMs
    const requestId = candidate.requestId
    const offloadImages = candidate.offloadImages
    if (typeof message !== 'string' || message.length === 0
      || typeof code !== 'string' || code.length === 0
      || (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
      || (providerRetryAfterMs !== undefined
        && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0))
      || (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0))
      || (offloadImages !== undefined && (!Number.isSafeInteger(offloadImages) || offloadImages <= 0))) return undefined
    return Object.freeze({
      message: formatLlmFailure({ message, code, ...status === undefined ? {} : { status } }),
      code,
      ...status === undefined ? {} : { status },
      ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
      ...requestId === undefined ? {} : { requestId },
      ...offloadImages === undefined ? {} : { offloadImages },
    })
  } catch (_sdkFailureGetter) {
    return undefined
  }
}

/** Read an SDK error message without letting an accessor replace the primary failure. */
function errorMessage(error: Error): string {
  try {
    const message: unknown = error.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch (_sdkMessageGetter) {
    // The fallback below preserves a serializable failure beside the original Error.
  }
  return 'LLM adapter failed'
}

/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error: Error): string {
  return error instanceof HarnessError ? error.code : 'UNKNOWN'
}
