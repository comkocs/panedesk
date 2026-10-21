/** Version-one structural prefix hashing, independent of request identifiers and wall time. */
import { createHash } from 'node:crypto'
import type { ToolSchema } from '@panedesk/dsh-llm'

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  throw new Error('Prefix schemas must contain only lossless JSON values')
}

/** Sort declarations without mutating caller-owned schemas.
 * @param tools - complete declarations for the stable prefix.
 * @returns detached declarations in wire order.
 */
export function orderedTools(tools: readonly ToolSchema[]): ToolSchema[] {
  return structuredClone([...tools]).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/** Hash exact UTF-8 system text and canonical, name-ordered tool JSON using length-delimited fields.
 * @param system - stable system text, without dynamic tail context.
 * @param tools - initial tool declarations.
 * @returns version-one SHA-256 fingerprint.
 */
export function fingerprintPrefix(system: string, tools: readonly ToolSchema[]): string {
  const declarations = canonical(orderedTools(tools))
  return createHash('sha256').update(`v1:${Buffer.byteLength(system)}:`).update(system)
    .update(`:${Buffer.byteLength(declarations)}:`).update(declarations).digest('hex')
}
