/** Derived props for the shared subagent preset form and its two entries. */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { ConfigForm } from '@panedesk/dsh-client-ui-settings/client'
import type { LocaleSnapshot } from '@panedesk/dsh-client-locale/client'
import type { ModelCatalog } from '@panedesk/dsh-api-remotes/client'
import type { SubagentPresets } from '../types.ts'
import type {} from './locales.ts'

/** Product settings and catalog callbacks; components receive no service handles. */
export interface SubagentInjected {
  hooks: {
    subagentPresets: ConfigForm<{ subagentPresets: SubagentPresets }>
    subagentLocale: HostObservable<LocaleSnapshot>
  }
  saveSubagentPresets: (value: SubagentPresets, revision: number | undefined) => Promise<boolean>
  loadSubagentModels: () => Promise<ModelCatalog['groups']>
}

/** Shared form input, independent of the owning slot. */
export type SubagentProps = InjectFace<SubagentInjected> & PropsLocale<'projectOnboarding'>
/** Settings page entry. */
export type SubagentSettingsProps = PropsRuntime<'settings.section'> & SubagentProps
/** New-session upper-right entry. */
export type SubagentQuickProps = PropsRuntime<'conversation.hero.actions'> & SubagentProps
