/** Derived slot props for project preferences and first-entry guidance. */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type { ConfigFormSnapshot } from '@panedesk/dsh-client-ui-settings/client'
import type { ProjectSelection } from '../types.ts'
import type { ProjectPreferences } from './controller.ts'
import type {} from './locales.ts'

/** Feature-private data and actions bound by the renderer. */
export interface ProjectInjected {
  hooks: { preferences: HostObservable<ProjectPreferences> }
  retry: () => Promise<void>
  select: (path: string, mode: ProjectSelection['mode']) => Promise<boolean>
}

/** Existing welcome preference read through the shared configuration form. */
export interface GuideInjected extends ProjectInjected {
  hooks: ProjectInjected['hooks'] & { welcome: HostObservable<ConfigFormSnapshot<Record<string, unknown>>> }
}

/** Session-only first-entry modal. */
export type GuideProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<GuideInjected> & PropsLocale<'projectOnboarding'>
/** Settings-only observations and native file actions; the conversation overlay does not consume them. */
export interface SettingsInjected extends ProjectInjected {
  hooks: ProjectInjected['hooks'] & { inspection: HostObservable<import('./settings-controller.ts').OpeningInspection> }
  refresh: () => Promise<void>
  openPath: (path: string, action: 'open' | 'reveal') => Promise<boolean>
}

/** Product settings page, available without a Session. */
export type SettingsProps = PropsRuntime<'settings.section'> & InjectFace<SettingsInjected> & PropsLocale<'projectOnboarding'>
