/** Opt-in startup import of Claude Code agent types. */
import { useState } from 'react'
import { Switch } from '@panedesk/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@panedesk/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@panedesk/dsh-client-ui-settings/client'
import css from './DeveloperToolsRow.module.css'

/** Registry preference persisted through the shared settings form. */
export interface ClaudeAgentTypesSettings {
  readClaudeAgentTypes: boolean
}

/** Accepted preference and writer supplied by the settings registration. */
export interface ClaudeAgentTypesRowInjected {
  hooks: { preferences: ObservableSnapshot<ConfigFormSnapshot<ClaudeAgentTypesSettings>> }
  setEnabled(enabled: boolean): Promise<boolean>
}

/** Render the restart-required import switch.
 * @param props Accepted configuration, writer, and localized copy.
 * @returns The Panedesk feature row.
 */
export function ClaudeAgentTypesRow({ usePreferences, setEnabled, t }:
  PropsRuntime<'settings.panedesk.item'> & PropsLocale<'settings'> & InjectFace<ClaudeAgentTypesRowInjected>) {
  const snapshot = usePreferences(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <div className={css.row}>
    <div>
      <div className={css.title}>{t('claudeAgentTypes.title')}</div>
      <div className={css.description}>{t('claudeAgentTypes.description')}</div>
      {failed && <div role="alert">{t('developerTools.error')}</div>}
    </div>
    <Switch checked={snapshot.value?.readClaudeAgentTypes ?? false}
      disabled={snapshot.status !== 'ready' || !snapshot.writable || busy} label={t('claudeAgentTypes.title')}
      onChange={next => {
        setFailed(false)
        setBusy(true)
        void setEnabled(next).then(accepted => { setFailed(!accepted) })
          .catch(() => { setFailed(true) }).finally(() => { setBusy(false) })
      }} />
  </div>
}
