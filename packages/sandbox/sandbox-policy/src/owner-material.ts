/** Resolve owner identity storage from the active providers and desktop carrier. */
import { join, resolve } from 'node:path'
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-credentials'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import { canonicalPath } from '@panedesk/dsh-sandbox'

/**
 * Collect the single owner-material inventory consumed by file and process confinement.
 * @param ctx - Running host service context.
 * @returns Original spellings and canonical paths, including absent default storage.
 */
export function resolveOwnerMaterialPaths(ctx: Context): string[] {
  const roots = new Set<string>([
    ...ctx.get('credentials')?.protectedStoragePaths ?? [join(resolveDshHome(), 'private')],
  ])
  const desktopPaths = process.env.DSH_DESKTOP_PRIVATE_PATHS
  if (desktopPaths !== undefined) {
    const paths: unknown = JSON.parse(desktopPaths)
    if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) {
      throw new Error('Desktop private paths must be a JSON string array')
    }
    for (const path of paths) roots.add(path)
  }
  return [...new Set([...roots].flatMap(path => [resolve(path), canonicalPath(path)]))].sort()
}
