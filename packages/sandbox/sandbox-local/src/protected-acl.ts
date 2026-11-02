/** Apply capability-specific denies after broad workspace grants. */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalPath } from '@panedesk/dsh-sandbox'
import type { AclWriteGrant } from '@panedesk/dsh-sandbox-windows-acl'

/** Keep ordinary descendants writable while protecting existing inputs and ancestor names.
 * Missing names and reparse-point replacement additionally need host-side validation.
 * @param grant - Workspace capability holding the broad write grant.
 * @param workspace - Canonical writable workspace.
 * @param paths - Live protected names and targets.
 */
export function protectAclInputs(grant: AclWriteGrant, workspace: string, paths: readonly string[]): void {
  const contains = (root: string, path: string): boolean => {
    const suffix = relative(root, path)
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  }
  const inputs = [...new Set(paths.flatMap(path => [resolve(path), canonicalPath(path)]))]
  const parents = new Set<string>()
  for (const path of inputs) {
    if (!contains(workspace, path) && !contains(path, workspace)) continue
    if (existsSync(path)) grant.protect(path)
    for (let parent = dirname(path); parent !== workspace && contains(workspace, parent); parent = dirname(parent)) {
      parents.add(parent)
    }
  }
  for (const parent of parents) if (existsSync(parent)) grant.protect(parent, false)
}
