/** Bounded JSON framing and canonical digests shared by authenticated transports. */
import { createHash } from 'node:crypto'

/** JSON values exclude executable objects and non-finite numbers. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Narrow a decoded JSON object.
 * @param value - Untrusted input.
 * @returns Whether named fields can be inspected.
 */
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/** Bounded identifiers reject control characters.
 * @param value - Untrusted identifier.
 * @returns Whether the value can serve as a wire identity.
 */
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value)
}
/** Canonical JSON keeps object-key order out of operation identity.
 * @param value - JSON-compatible input.
 * @returns Canonical text; unsupported values or excessive nesting reject.
 */
export function canonical(value: unknown): string {
  const encode = (input: unknown, depth: number): string => {
    if (depth > 64) throw new Error('JSON nesting rejected')
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input)
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input)
    if (Array.isArray(input)) return `[${input.map(item => encode(item, depth + 1)).join(',')}]`
    if (object(input)) return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${encode(input[key], depth + 1)}`).join(',')}}`
    throw new Error('JSON value rejected')
  }
  return encode(value, 0)
}
/** Compute a stable digest without retaining request text in diagnostics.
 * @param value - JSON-compatible input.
 * @returns Lowercase SHA-256 digest.
 */
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

/** Parse a bounded UTF-8 JSON frame.
 * @param text - Wire or persisted text.
 * @param maxBytes - Complete frame limit.
 * @returns Parsed JSON without granting application authority.
 */
export function parseJson(text: string, maxBytes: number): unknown {
  if (Buffer.byteLength(text) > maxBytes) throw new Error('JSON frame exceeds limit')
  const value: unknown = JSON.parse(text)
  canonical(value)
  return value
}
