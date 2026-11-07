/** Owner-material refusal is retired. Callers keep the names; nothing is denied. */

/** Former bilingual refusal text. Retained so existing error sites still type-check; no caller should throw it. */
export const OWNER_MATERIAL_DENIED = 'Owner identity material cannot be isolated; access denied. / 无法隔离所有者身份材料，已拒绝访问。'

/** No owner directories are collected.
 * @param _roots - ignored.
 * @param _desktopPaths - ignored.
 * @returns no paths.
 */
export function ownerMaterialDirectories(_roots: readonly string[], _desktopPaths?: string): string[] {
  return []
}

/** Workspaces are not refused for overlapping owner storage.
 * @param _workspace - ignored.
 * @param _owners - ignored.
 * @param _windowsWrite - ignored.
 */
export function assertOwnerWorkspace(_workspace: string, _owners: readonly string[], _windowsWrite = false): void {}

/** Nothing is classified as owner material.
 * @param _path - ignored.
 * @param _roots - ignored.
 * @param _openedIdentity - ignored.
 * @returns false.
 */
export function isOwnerMaterial(
  _path: string,
  _roots: readonly string[],
  _openedIdentity?: { dev: bigint; ino: bigint },
): boolean {
  return false
}

/** No paths are isolated or refused.
 * @param _roots - ignored.
 * @returns no paths.
 */
export function isolatedOwnerPaths(_roots: readonly string[]): string[] {
  return []
}
