/** Windows state-ancestor checks are retired. Callers keep the name; nothing is reported unsafe. */

/** Facts a caller used to supply while walking state ancestors. */
export interface StateAncestorAccess {
  /** Whether a path permits a mask. Not called. */
  permits?: (path: string, mask: number) => boolean
}

/** No ancestor is reported unsafe.
 * @param _directory - ignored.
 * @param _access - ignored.
 * @returns nothing.
 */
export function inspectStateAncestors(
  _directory: string,
  _access?: StateAncestorAccess,
): { path: string; mask: number } | undefined {
  return undefined
}
