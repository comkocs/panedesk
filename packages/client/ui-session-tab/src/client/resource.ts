/** The resource lifetime owns one retained session reference per open sidebar transcript. */
import type { ISessions, SessionReference } from '@panedesk/dsh-api-session-controller/client'
import { RemoteError } from '@panedesk/dsh-typert-protocol'
import type { ResourceProvider } from '@panedesk/dsh-client-resources/client'
import type { SessionId } from '@panedesk/dsh-session/types'

/** A retained transcript, never persisted into sidebar layout. */
export interface SessionTabResource {
  readonly reference: SessionReference
}

declare module '@panedesk/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { sessionTab: unknown }
}

declare module '@panedesk/dsh-client-ui-slots' {
  interface ResourceProtocolMap { sessiontab: SessionTabResource }
  interface SlotMap {
    /** Independently bound transcript inside the sidebar session page. */
    'sidebar.session.conversation': { kind: 'single'; scope: 'session' }
  }
}

/** Address the session a page displays.
 * @param sessionId - durable session identity.
 * @returns resource address consumed by the session-tab provider.
 */
export function sessionTabAddress(sessionId: SessionId): string {
  return `dsh-resource://sessiontab/${encodeURIComponent(sessionId)}`
}

/** Build the provider that releases its reference when the final resource reader leaves.
 * @param sessions - injected client session model.
 * @returns a session-tab resource provider.
 */
export function sessionTabProvider(sessions: ISessions): ResourceProvider<'sessiontab'> {
  return {
    protocol: 'sessiontab',
    async *open(address, { signal }) {
      const id = decodeURIComponent(new URL(address).pathname.slice(1)) as SessionId
      const aborted = (): boolean => signal.aborted
      if (aborted()) return
      const reference = sessions.retain(id, { source: 'sessionTab', signal })
      try {
        try { await reference.ready }
        catch (_openFailed) {
          if (!aborted()) yield { ok: false, error: new RemoteError('session/not-found', 'The session could not be opened', { sessionId: id }) }
          return
        }
        if (aborted()) return
        yield { ok: true, value: { reference } }
        if (!aborted()) await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      } finally { reference.release() }
    },
  }
}
