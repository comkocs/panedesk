/** Catalog paths retain their own syntax; filesystem operations require native paths. */
import path from 'node:path'
import type { SeatDefinition, SeatRejected } from '@panedesk/dsh-seat'
import { rejected } from './errors.ts'

/** Identify fully qualified drive and UNC paths before considering POSIX syntax.
 * @param value - catalog path.
 * @returns its absolute path style, or null for relative paths.
 */
export function pathStyle(value: string): 'posix' | 'win32' | null {
  if (/^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value)) return 'win32'
  return path.posix.isAbsolute(value) ? 'posix' : null
}

/** Normalize comparison keys without conflating volumes or path styles.
 * @param value - validated absolute catalog path.
 * @returns style-qualified key with case-insensitive Windows comparison.
 */
export function pathKey(value: string): string {
  const style = pathStyle(value)
  return style === 'win32' ? `win32:${path.win32.normalize(value).toLowerCase()}` : `posix:${path.posix.normalize(value)}`
}

/** Check whether a catalog path is usable by the executing filesystem.
 * @param value - absolute catalog path.
 * @param platform - host path implementation; explicit values support platform stubs.
 * @returns whether its style matches the host.
 */
export function isNativePath(value: string, platform: 'posix' | 'win32' = process.platform === 'win32' ? 'win32' : 'posix'): boolean {
  return pathStyle(value) === platform
}

/** Refuse incompatible paths before filesystem effects.
 * @param paths - paths the local operation will use.
 * @returns actionable definition refusal, or null.
 */
export function validateLocalPaths(paths: readonly string[]): SeatRejected | null {
  return paths.every(value => isNativePath(value)) ? null
    : rejected('invalid-definition', 'The definition contains paths incompatible with this node.',
      'Edit the definition to use absolute paths native to its owning node.')
}

/** Validate executable paths, excluding import-source metadata that is not opened at runtime.
 * @param definition - resolved owning-node definition.
 * @returns refusal before local assembly, or null.
 */
export function validateLocalDefinition(definition: SeatDefinition): SeatRejected | null {
  return validateLocalPaths([...definition.directories.map(item => item.path), ...definition.memoryDirectories,
    ...definition.openingInstructionFiles, ...definition.subscriptions, ...definition.checkpointFiles.map(item => item.path),
    ...[definition.opening, definition.wakeTemplate].flatMap(item => item?.kind === 'file' ? [item.path] : [])])
}
