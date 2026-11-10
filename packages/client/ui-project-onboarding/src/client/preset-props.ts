/** Derived props for the opening-preset settings page and new-session selectors. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { ConfigForm } from '@panedesk/dsh-client-ui-settings/client'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { ModelCatalog } from '@panedesk/dsh-api-remotes/client'
import type { OpeningPreset } from '../types.ts'
import type {} from './locales.ts'

/** Current Host choices loaded when the preset editor opens. */
export interface PresetChoices {
  models: ModelCatalog['groups']
  permissions: { id: string; label: string }[]
}

/** Shared configuration and feature-local actions; components receive no services. */
export interface PresetsInjected {
  hooks: {
    presets: ConfigForm<{ openingPresets: OpeningPreset[] }>
    document: ReturnType<import('@panedesk/dsh-client-ui-settings/client').ConfigForms['describe']>
  }
  savePresets: (presets: OpeningPreset[], revision: number | undefined) => Promise<boolean>
  namePreset: (prompt: string) => string
  loadChoices: () => Promise<PresetChoices>
  inferDirectory: (prompt: string) => Promise<string>
  importPresets: (text: string, table: boolean) => Promise<OpeningPreset[]>
  pickDirectory: () => Promise<string | null>
  droppedPaths: (files: File[]) => string[]
  openDocument: () => Promise<void>
  managePresets: () => void
  choosePreset: (index: number, directory: string, sessionId?: SessionId) => Promise<void>
}

/** Shared editor's locale and injected projection. */
export type PresetsProps = InjectFace<PresetsInjected> & PropsLocale<'projectOnboarding'>
/** Product settings page. */
export type PresetSettingsProps = PropsRuntime<'settings.section'> & PresetsProps
/** Opening selector beside the workspace. */
export type PresetPickerProps = PropsRuntime<'conversation.hero.opening'> & PresetsProps
/** New-session quick management entry. */
export type PresetQuickProps = PropsRuntime<'conversation.hero.actions'> & PresetsProps
