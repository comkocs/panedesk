/** Session-only project guidance and path-keyed product preferences. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-api-remotes/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import contribution from '@panedesk/dsh-client-ui-project-onboarding/remote'
import { ProjectPreferencesController } from './controller.ts'
import { ProjectGuide, ProjectSettings } from './ProjectGuide.tsx'
import { en, zh } from './locales.ts'
import type { GuideInjected, ProjectInjected } from './props.ts'

/** Services used by the preferences projection and its slot contributions. */
export const inject = ['slots', 'locale', 'remote', 'configForms']

/** Register the project settings page and an overlay absent from the launch screen.
 * @param ctx Client plugin scope; no service objects reach React components.
 * @returns Asynchronous release of slots, listeners, and the mounted remote contribution.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.projectOpening'], (ctx) => {
    ctx.effect(() => ctx.locale.register('projectOnboarding', { en, zh }))
    const mirror = ctx.configForms.describe()
    const controller = new ProjectPreferencesController({
      describe: async () => {
        await mirror.ensure()
        const snapshot = mirror.getSnapshot()
        return snapshot.view === undefined
          ? { ok: false }
          : { ok: true, value: { ...snapshot.view, namespaces: [...snapshot.view.namespaces] } }
      },
      select: async (path, selection, revision) => {
        const response = await ctx.remote.projectOpening.select(path, selection, revision)
        if (response.ok) mirror.acceptView(response.value)
        return response
      },
    })
    const face = (): ProjectInjected => ({
      hooks: { preferences: controller.state }, retry: () => controller.load(),
      select: (path, mode) => controller.select(path, mode),
    })
    const welcome = ctx.configForms.get<Record<string, unknown>>('ui-settings-general')
    const guideFace = (): GuideInjected => ({ ...face(), hooks: { preferences: controller.state, welcome } })
    ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
      name: 'conversation.input.overlay', id: 'project-onboarding', order: 1,
      locale: 'projectOnboarding', inject: guideFace,
    }, ProjectGuide))
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'project-opening', group: 'panedesk', order: 25,
      label: () => ctx.locale.bind('projectOnboarding')('title'),
      locale: 'projectOnboarding', inject: face,
    }, ProjectSettings))
    ctx.effect(() => mirror.subscribe(() => {
      // Failed initial reads stay retryable without recursively starting another read.
      if (mirror.getSnapshot().view !== undefined) void controller.load()
    }))
    ctx.effect(() => () => { controller.dispose() })
    void controller.load()
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
