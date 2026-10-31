/** A session-addressed cache reading, refreshed within the display's five-second accuracy budget. */
import type { ResourceProvider } from '@panedesk/dsh-client-resources/client'
import { waitForPoll } from '@panedesk/dsh-client-resources/polling'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { CacheRead } from './view.ts'

declare module '@panedesk/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Authorized cache evidence, including named unavailable and failure states. */
    sessioncache: CacheRead
  }
}

/** Create the resource owner for cache evidence.
 * @param read - authorized Remote reader for one session.
 * @returns a provider whose polling stops with the last resource consumer.
 */
export function cacheProvider(read: (id: SessionId) => Promise<CacheRead>): ResourceProvider<'sessioncache'> {
  return {
    protocol: 'sessioncache',
    async *open(address, { signal }) {
      const sessionId = decodeURIComponent(new URL(address).pathname.slice(1)) as SessionId
      const aborted = (): boolean => signal.aborted
      while (!aborted()) {
        let value: CacheRead
        try { value = await read(sessionId) }
        catch (_readFailed) { value = { status: 'error' } }
        if (aborted()) return
        yield { ok: true, value }
        await waitForPoll(signal, 4000)
      }
    },
  }
}
