/** Portable relative paths used in durable ledger references and identities. */
import path from 'node:path'

/** Relativize a ledger-owned file without platform-dependent separators.
 * @param root - Owning ledger directory.
 * @param file - File beneath the owning directory.
 * @param pathApi - Path implementation for the input paths; defaults to the host implementation.
 * @returns Relative path using forward slashes, matching persisted ledger references.
 */
export function ledgerRelative(root: string, file: string, pathApi: Pick<typeof path, 'relative' | 'sep'> = path): string {
  return pathApi.relative(root, file).split(pathApi.sep).join('/')
}
