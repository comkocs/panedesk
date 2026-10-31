/** Mount the generated inbox read bridge and its Session-header contribution. */
import type { Context } from '@panedesk/cordis'
import contribution from '@panedesk/dsh-client-ui-inbox/remote'
import type {} from '@panedesk/dsh-api-gateway/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type { SessionId } from '@panedesk/dsh-session'
import { RemoteError, remoteErrorOf, type RemoteResult } from '@panedesk/dsh-typert-protocol'
import type { InboxView } from '../types.ts'
import { InboxPanel } from './panel.tsx'
import { en, zh, type InboxKey } from './locales.ts'

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { inbox: InboxKey }
  interface ResourceProtocolMap { inbox: InboxView }
}
/** Required contribution registries and generated transport. */
export const inject = ['remote', 'slots', 'locale', 'resources']

/** Install a read-only entry only in an active Session header.
 * @param ctx - Client plugin lifetime and registries.
 * @returns Disposal of generated Remote, locale, resource and UI contributions.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.inbox'], (scope) => {
    scope.effect(() => scope.locale.register('inbox', { en, zh }), 'inbox: locale')
    scope.effect(() => scope.resources.register<'inbox'>({
      protocol: 'inbox',
      async *open(address, { signal }): AsyncIterable<RemoteResult<InboxView>> {
        const sessionId = decodeURIComponent(new URL(address).pathname.slice(1)) as SessionId
        try { for await (const value of scope.remote.inbox.watch(sessionId, signal)) yield { ok: true, value } }
        catch (error) { if (!signal.aborted) yield { ok: false, error: remoteErrorOf(error)
          ?? new RemoteError('inbox/unavailable', 'Inbox observation unavailable', {}) } }
      },
    }), 'inbox: resource')
    scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
      name: 'conversation.session.header.actions', id: '@panedesk/dsh-client-ui-inbox', order: 30, locale: 'inbox',
    }, InboxPanel))
  })
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}
