/** Workspace verification settings contribution over the owner-only remote service. */
import type { Context } from '@panedesk/cordis'
import contribution from '@panedesk/dsh-verification-policy/remote'
import type {} from '@panedesk/dsh-api-gateway/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-workspace/client'
import type { RemoteResult } from '@panedesk/dsh-typert-protocol'
import type { WorkspaceId } from '@panedesk/dsh-workspace/types'
import type { VerificationSaveRequest, VerificationView } from '@panedesk/dsh-verification-policy/types'
import { VerificationPage } from './page.tsx'
import { en, zh, type VerificationKey } from './locales.ts'

/** Settings mutation supplied by the remote-owning registration. */
export interface VerificationActions {
  save(this: void, request: VerificationSaveRequest): Promise<RemoteResult<VerificationView>>
}

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { verification: VerificationKey }
  interface ResourceProtocolMap { verification: VerificationView }
}

/** Services used by registration and all injected callbacks. */
export const inject = ['remote', 'slots', 'locale', 'resources']

/** Mount the API and register the Panedesk settings page.
 * @param ctx Client plugin scope.
 * @returns Disposal of API and UI contributions.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.verificationPolicy'], scope => {
    scope.effect(() => scope.locale.register('verification', { en, zh }))
    scope.effect(() => scope.resources.register<'verification'>({
      protocol: 'verification', async *open(address) {
        const workspaceId = decodeURIComponent(new URL(address).pathname.slice(1)) as WorkspaceId
        yield await scope.remote.verificationPolicy.readWorkspace({ workspaceId })
      },
    }))
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'verification', group: 'panedesk', order: 40,
      label: () => scope.locale.bind('verification')('title'), locale: 'verification',
      inject: (): VerificationActions => ({ save: request => scope.remote.verificationPolicy.saveWorkspace(request) }),
    }, VerificationPage))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
