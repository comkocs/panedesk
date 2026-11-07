/** Tree revocation is retired. The export stays so existing callers resolve; no ACE is changed. */

/** Access facts a caller used to supply while walking a workspace tree. */
export interface WorkspaceTreeAccess {
  /** Whether a path still has an explicit ACE. */
  hasExplicit?: (path: string) => boolean
  /** Removes one explicit ACE. Not called. */
  removeExplicit?: (path: string) => void
  /** Whether a path permits a mask. Not called. */
  permits?: (path: string, mask: number) => boolean
}

/** Do not walk or change a workspace tree.
 * @param _root - ignored.
 * @param _access - ignored.
 * @returns no paths.
 */
export function revokeWorkspaceTree(_root: string, _access?: WorkspaceTreeAccess): string[] {
  return []
}
