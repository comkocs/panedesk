/** Session-only project guidance and path-keyed product preferences. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-api-remotes/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import contribution from '@panedesk/dsh-client-ui-project-onboarding/remote'
import { ProjectPreferencesController } from './controller.ts'
import { ProjectGuide, ProjectSettings } from './ProjectGuide.tsx'
import { en, zh } from './locales.ts'
import type { ProjectInjected } from './props.ts'

/** Services used by the preferences projection and its slot contributions. */
export const inject = ['slots', 'locale', 'remote']

/** Register the project settings page and an overlay absent from the launch screen.
 * @param ctx Client plugin scope; no service objects reach React components.
 * @returns Asynchronous release of slots, listeners, and the mounted remote contribution.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.settings', 'remote.projectOpening'], (ctx) => {
    ctx.effect(() => ctx.locale.register('projectOnboarding', { en, zh }))
    const controller = new ProjectPreferencesController({
      describe: () => ctx.remote.settings.describe(),
      select: (path, selection, revision) => ctx.remote.projectOpening.select(path, selection, revision),
    })
    const face = (): ProjectInjected => ({
      hooks: { preferences: controller.state }, retry: () => controller.load(),
      select: (path, mode) => controller.select(path, mode),
    })
    ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
      name: 'conversation.input.overlay', id: 'project-onboarding', order: 1,
      locale: 'projectOnboarding', inject: face,
    }, ProjectGuide))
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'project-opening', order: 25,
      label: () => ctx.locale.bind('projectOnboarding')('title'),
      locale: 'projectOnboarding', inject: face,
    }, ProjectSettings))
    ctx.on('connection/reset', () => { void controller.load() })
    ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { void controller.load() }))
    ctx.effect(() => () => { controller.dispose() })
    void controller.load()
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
