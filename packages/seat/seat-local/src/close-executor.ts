/** Public archive, title and flush effects run under the engine close barrier. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-host-admin'
import type { SeatCloseExecutor } from '@panedesk/dsh-seat'
import type { LocalSeatOptions, LocalSeatRuntime } from './service-options.ts'
import { readWindowStatus } from './status.ts'

/** Reject archive on unknown busy evidence without stopping active work.
 * @param ctx - owning context.
 * @param runtime - live state observer.
 * @param options - deployment close-title suffix.
 * @returns side-effect executor for engine registration.
 */
export function createCloseExecutor(ctx: Context, runtime: LocalSeatRuntime, options: LocalSeatOptions): SeatCloseExecutor {
  return {
    evidence: async (sessionId) => {
      const evidence = await runtime.evidence(sessionId)
      return { stateVersion: evidence.stateVersion, busyReasons: readWindowStatus(evidence).busyReasons }
    },
    archive: async (request) => {
      const workspace = ctx.get('workspaceRegistry')
      const sessions = ctx.get('sessions')
      const titles = ctx.get('sessionTitle')
      const session = sessions?.get(request.sessionId)
      if (workspace === undefined || sessions === undefined || titles === undefined || session === undefined) {
        throw new Error('Close providers are unavailable')
      }
      if (!workspace.archivedSessionIds.includes(request.sessionId)) {
        const evidence = await runtime.evidence(request.sessionId)
        if (readWindowStatus(evidence).busyReasons.length) throw new Error('Window is not idle')
        await workspace.archiveSession(request.sessionId)
      }
      await ctx.get('hostSessionCredentials')?.revoke(request.sessionId)
      const title = titles.get(session)?.title
      if (title === undefined) throw new Error('Window title is unavailable')
      if (!title.endsWith(options.closedSuffix)) titles.rename(session, `${title}${options.closedSuffix}`)
      await sessions.flush(session)
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) throw new Error('Session persistence is unavailable')
      await persistence.flush()
    },
  }
}
