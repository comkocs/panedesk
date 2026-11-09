/** Session-only project guidance and path-keyed product preferences. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-api-remotes/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import contribution from '@panedesk/dsh-client-ui-project-onboarding/remote'
import type {} from '@panedesk/dsh-client-ui-workspace/client'
import type {} from '@panedesk/dsh-api-workspace-controller/client'
import type { OpeningNamePattern } from '@panedesk/dsh-session-title/client'
import type { OpeningPreset } from '../types.ts'
import type { PresetsInjected } from './preset-props.ts'
import { OpeningPresetSettings, OpeningPresetPicker, OpeningPresetQuick } from './OpeningPresets.tsx'
import { importPresets, openingPresetName } from './preset-import.ts'
import { ProjectPreferencesController } from './controller.ts'
import { ProjectGuide } from './ProjectGuide.tsx'
import { ProjectSettings } from './ProjectSettings.tsx'
import { WorkflowStarters, WorkflowStartersSetting } from './WorkflowStarters.tsx'
import { ProjectSettingsController } from './settings-controller.ts'
import { en, zh } from './locales.ts'
import type { GuideInjected, ProjectInjected, SettingsInjected, WorkflowInjected } from './props.ts'

/** Services used by the preferences projection and its slot contributions. */
export const inject = ['slots', 'locale', 'remote', 'configForms']

/** Register project settings, optional workflow starters, and the project guidance overlay.
 * @param ctx Client plugin scope; no service objects reach React components.
 * @returns Asynchronous release of slots, listeners, and the mounted remote contribution.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.projectOpening', 'remote.session', 'remote.settings', 'uiWorkspace', 'workspaces', 'sessions', 'conversation', 'settingsNavigation'], (ctx) => {
    ctx.effect(() => ctx.locale.register('projectOnboarding', { en, zh }))
    const mirror = ctx.configForms.describe()
    const presets = ctx.configForms.get<{ openingPresets: OpeningPreset[] }>('ui-project-onboarding')
    const naming = ctx.configForms.get<{ openingName?: OpeningNamePattern }>('ui-settings-general')
    const desktop = globalThis as typeof globalThis & {
      __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> }
      __DSH_HOST_PATHS__?: { pathFor(file: File): string }
    }
    const presetFace = (): PresetsInjected => ({
      hooks: { presets, document: mirror },
      savePresets: (value, revision) => presets.mutate([{ op: 'set', path: ['openingPresets'], value: value.map(row => ({ ...row })) }], revision),
      namePreset: prompt => openingPresetName(prompt, naming.getSnapshot().value?.openingName),
      importPresets: async (text, table) => {
        const rows = importPresets(text, table)
        if (!table) {
          const inferred = await ctx.remote.projectOpening.inferDirectories(rows.map(row => row.prompt))
          if (!inferred.ok) throw new Error(inferred.error.message)
          rows.forEach((row, index) => { const path = inferred.value[index]; row.directories = path ? [path] : [] })
        }
        return rows.map(row => ({ ...row, name: openingPresetName(row.prompt, naming.getSnapshot().value?.openingName) }))
      },
      pickDirectory: () => desktop.__DSH_DIRECTORY_PICKER__?.pick() ?? ctx.uiWorkspace.pickDirectory(),
      droppedPaths: files => files.map(file => desktop.__DSH_HOST_PATHS__?.pathFor(file) ?? '').filter(Boolean),
      openDocument: async () => {
        const result = await ctx.remote.settings.openSettingsDocument()
        if (!result.ok) throw new Error(result.error.message)
      },
      managePresets: () => ctx.settingsNavigation.openSection('opening-presets'),
      choosePreset: async (index, directory, sessionId) => {
        const preset = presets.getSnapshot().value!.openingPresets[index]!
        let binding = sessionId === undefined ? undefined : ctx.sessions.binding(sessionId)
        if (binding === undefined) {
          const workspace = await ctx.workspaces.create({ path: directory })
          await ctx.uiWorkspace.openWorkspace(workspace.workspaceId, id => { binding = ctx.sessions.binding(id) })
        }
        if (!binding) return
        const initialized = ctx.conversation.input.requestDraftInitialization(binding, { prompt: preset.prompt, clearPreviousDraft: true })
        if (initialized === 'blocked') throw new Error(ctx.locale.bind('projectOnboarding')('unavailable'))
        if (preset.model) {
          const catalog = await ctx.remote.session.modelCatalog()
          if (!catalog.ok) throw new Error(catalog.error.message)
          const choice = catalog.value.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model,
            keys: [`${group.id}/${model.id}`, model.id, model.name] })))
            .find(item => item.keys.some(key => preset.model === key || preset.model!.startsWith(key + ' / ') || preset.model!.startsWith(key + ' ')))
          if (!choice) throw new Error(`Unknown model: ${preset.model}`)
          const key = choice.keys.find(key => preset.model === key || preset.model!.startsWith(key + ' / ') || preset.model!.startsWith(key + ' '))!
          const effort = preset.model.slice(key.length).replace(/^\s*\/\s*/u, '').trim()
          const selected = await ctx.remote.session.selectModel({ sessionId: binding.sessionId, provider: choice.provider,
            model: choice.model.id, ...(effort ? { reasoningEffort: effort } : {}) })
          if (!selected.ok) throw new Error(selected.error.message)
        }
        if (preset.permission) {
          const result = await binding.session.command(`/permission ${preset.permission}`)
          if (!result.ok) throw new Error(result.error.message)
          if (!result.value.matched) throw new Error('Permission command unavailable')
        }
        const titled = await ctx.remote.projectOpening.selectPreset(binding.sessionId, index)
        if (!titled.ok) throw new Error(titled.error.message)
        ctx.conversation.input.for(binding.ctx).focus()
      },
    })
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'opening-presets', group: 'panedesk', order: 26,
      label: () => ctx.locale.bind('projectOnboarding')('presetsTitle'), locale: 'projectOnboarding', inject: presetFace,
    }, OpeningPresetSettings))
    ctx.slots.inject('conversation.hero.opening', () => ctx.slots.register({
      name: 'conversation.hero.opening', locale: 'projectOnboarding', inject: presetFace,
    }, OpeningPresetPicker))
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions', id: 'opening-presets', order: 21, locale: 'projectOnboarding', inject: presetFace,
    }, OpeningPresetQuick))
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
    const settings = new ProjectSettingsController(ctx.remote.projectOpening, ctx.remote.session)
    const settingsFace = (): SettingsInjected => ({ ...face(),
      hooks: { preferences: controller.state, inspection: settings.state },
      refresh: () => settings.load(), openPath: (path, action) => settings.openPath(path, action),
    })
    const workflow = ctx.configForms.get<{ showWorkflowStarters: boolean }>('ui-project-onboarding')
    const workflowFace = (): WorkflowInjected => ({
      hooks: { workflow }, setEnabled: enabled => workflow.set('showWorkflowStarters', enabled),
    })
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock', id: 'workflow-starters', order: 0,
      locale: 'projectOnboarding', inject: workflowFace,
    }, WorkflowStarters))
    ctx.effect(() => ctx.configForms.whileServed(['ui-project-onboarding'], () =>
      ctx.slots.inject('settings.panedesk.item', () => ctx.slots.register({
        name: 'settings.panedesk.item', id: 'workflow-starters', order: 30,
        locale: 'projectOnboarding', inject: workflowFace,
      }, WorkflowStartersSetting))))
    const welcome = ctx.configForms.get<Record<string, unknown>>('ui-settings-general')
    const guideFace = (): GuideInjected => ({ ...face(), hooks: { preferences: controller.state, welcome } })
    ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
      name: 'conversation.input.overlay', id: 'project-onboarding', order: 1,
      locale: 'projectOnboarding', inject: guideFace,
    }, ProjectGuide))
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'project-opening', group: 'panedesk', order: 25,
      label: () => ctx.locale.bind('projectOnboarding')('title'),
      locale: 'projectOnboarding', inject: settingsFace,
    }, ProjectSettings))
    ctx.effect(() => mirror.subscribe(() => {
      // Failed initial reads stay retryable without recursively starting another read.
      if (mirror.getSnapshot().view !== undefined) void controller.load()
    }))
    ctx.effect(() => () => { controller.dispose(); settings.dispose() })
    void controller.load()
    void settings.load()
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
