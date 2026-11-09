/** Derived slot props for project preferences and first-entry guidance. */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@panedesk/dsh-client-ui-slots'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type { ConfigFormSnapshot } from '@panedesk/dsh-client-ui-settings/client'
import type { ProjectSelection } from '../types.ts'
import type { WorkflowPrompts } from '../workflow-defaults.ts'
import type { ProjectPreferences } from './controller.ts'
import type {} from './locales.ts'

/** Feature-private data and actions bound by the renderer. */
export interface ProjectInjected {
  hooks: { preferences: HostObservable<ProjectPreferences> }
  retry: () => Promise<void>
  select: (path: string, mode: ProjectSelection['mode']) => Promise<boolean>
}

/** Existing welcome preference read through the shared configuration form. */
export interface GuideInjected extends ProjectInjected, WorkflowInjected {
  hooks: ProjectInjected['hooks'] & WorkflowInjected['hooks'] & { welcome: HostObservable<ConfigFormSnapshot<Record<string, unknown>>> }
}

/** Session-only first-entry modal. */
export type GuideProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<GuideInjected> & PropsLocale<'projectOnboarding'>
/** Settings-only observations and native file actions; the conversation overlay does not consume them. */
export interface SettingsInjected extends ProjectInjected {
  hooks: ProjectInjected['hooks'] & { inspection: HostObservable<import('./settings-controller.ts').OpeningInspection> }
  refresh: () => Promise<void>
  openPath: (path: string, action: 'open' | 'reveal') => Promise<boolean>
}

/** Workflow starter visibility, localized prompts, and product settings writers. */
export interface WorkflowInjected {
  hooks: {
    workflow: import('@panedesk/dsh-client-ui-settings/client').ConfigForm<WorkflowPrompts & { showWorkflowStarters: boolean }>
    workflowLocale: HostObservable<import('@panedesk/dsh-client-locale/client').LocaleSnapshot>
  }
  setEnabled: (enabled: boolean) => Promise<boolean>
  setPrompt: (key: keyof WorkflowPrompts, language: 'zh' | 'en', text: string) => Promise<boolean>
  manageWorkflow: () => void
}

/** Workflow interaction state shared by the hero entries and composer reset. */
type WorkflowSelectionProps = PropsStore<ReturnType<typeof import('./workflow-store.ts').createWorkflowStore>>
/** Optional starter entries above the new-session headline. */
export type WorkflowStarterProps = PropsRuntime<'conversation.hero.starters'> & WorkflowSelectionProps & InjectFace<WorkflowInjected> & PropsLocale<'projectOnboarding'>
/** Reset action above the composer after choosing a workflow. */
export type WorkflowResetProps = PropsRuntime<'conversation.input.dock'> & WorkflowSelectionProps & InjectFace<WorkflowInjected> & PropsLocale<'projectOnboarding'>
/** Panedesk feature preference for the starter entries. */
export type WorkflowSettingsProps = PropsRuntime<'settings.section'> & InjectFace<WorkflowInjected> & PropsLocale<'projectOnboarding'>
/** Always-visible workflow menu on the blank-session screen. */
export type WorkflowQuickProps = PropsRuntime<'conversation.hero.actions'> & InjectFace<WorkflowInjected> & PropsLocale<'projectOnboarding'>

/** Product settings page, available without a Session. */
export type SettingsProps = PropsRuntime<'settings.section'> & InjectFace<SettingsInjected> & PropsLocale<'projectOnboarding'>
