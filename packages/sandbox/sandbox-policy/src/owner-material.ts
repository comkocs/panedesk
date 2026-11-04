/** Resolve owner identity storage from the active providers and desktop carrier. */
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-credentials'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import { ownerMaterialDirectories } from '@panedesk/dsh-sandbox'

/**
 * Collect the single owner-material inventory consumed by file and process confinement.
 * @param ctx - Running host service context.
 * @returns Original spellings and canonical paths, including absent default storage.
 */
export function resolveOwnerMaterialPaths(ctx: Context): string[] {
  return ownerMaterialDirectories(
    ctx.get('credentials')?.protectedStoragePaths ?? [join(resolveDshHome(), 'private')],
    process.env.DSH_DESKTOP_PRIVATE_PATHS,
  )
}
