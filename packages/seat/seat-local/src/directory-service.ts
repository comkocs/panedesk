/** Registered roots use the current Session filesystem and permission mode. */
import type { Context } from '@panedesk/cordis'
import { SeatDirectoryService, type SeatDefinition, type SeatDirectoryEditRequest,
  type SeatDirectoryReadRequest, type SeatDirectoryWriteRequest, type SeatBinding } from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import type {} from '@panedesk/dsh-sandbox-policy'
import type { LocalEngineState } from './engine-state.ts'
import { SeatDirectoryAccess } from './directories.ts'
import { refuse, rejected } from './errors.ts'

/** The optional injection owns disposal; ordinary file tools and shell write roots are unchanged. */
export class LocalSeatDirectoryService extends SeatDirectoryService {
  private readonly access: SeatDirectoryAccess
  constructor(ctx: Context, state: LocalEngineState, definitions: () => readonly SeatDefinition[]) {
    super(ctx)
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('Seat directory filesystem is unavailable')
    this.access = new SeatDirectoryAccess(fs, async (sessionId) => {
      const agent = ctx.get('agents')?.get(sessionId)
      const policy = ctx.get('sandboxPolicy')
      if (agent === undefined || policy === undefined) {
        refuse('unavailable', 'Directory permission evidence is unavailable.', 'Resume the local window before accessing its roots.')
      }
      let binding: SeatBinding | null = null
      for (const effect of (await state.read()).effects) {
        if (effect.kind === 'seat/binding' && effect.data.sessionId === sessionId) binding = effect.data
        if ((effect.kind === 'open/created' || effect.kind === 'open/configured') && effect.data.sessionId === sessionId) {
          binding = effect.data.binding
        }
        if (effect.kind === 'window/closed' && effect.data.sessionId === sessionId) binding = null
      }
      const resolved = policy.resolve({ session: agent.session })
      return { seat: binding?.kind === 'seat' ? binding.seat : null, definitions: definitions(), policy: resolved,
        admitWrite: () => Promise.resolve(resolved.mode === 'read-only'
          ? rejected('unauthorized', 'The session is read-only.', 'Change the session permission before writing.') : null) }
    })
  }
  roots(sessionId: SessionId) { return this.access.roots(sessionId) }
  read(request: SeatDirectoryReadRequest) { return this.access.read(request) }
  write(request: SeatDirectoryWriteRequest) { return this.access.write(request) }
  edit(request: SeatDirectoryEditRequest) { return this.access.edit(request) }
}
