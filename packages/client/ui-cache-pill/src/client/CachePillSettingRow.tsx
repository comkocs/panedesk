/** Feature-settings row that toggles the composer cache pill's visibility. */
import { useState } from 'react'
import { Switch } from '@panedesk/dsh-client-ui-primitives'
import type { ConfigForm } from '@panedesk/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import css from './CachePillSettingRow.module.css'

/** Editable fields projected from this plugin's Host configuration. */
export interface PillVisibility {
  visible: boolean
}

/** Shared configuration snapshot and ordered writer for the visibility preference. */
export interface CachePillSettingFace {
  hooks: { visibility: ConfigForm<PillVisibility> }
  setEnabled(enabled: boolean): Promise<boolean>
}

/**
 * Save the cache pill visibility through the product configuration form.
 * @param props - shared configuration snapshot, writer, and localized labels.
 * @returns one default-off Panedesk feature switch with save feedback.
 */
export function CachePillSettingRow({ useVisibility, setEnabled, t }:
PropsRuntime<'settings.panedesk.item'> & PropsLocale<'cachePill'> & InjectFace<CachePillSettingFace>) {
  const form = useVisibility(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const save = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try { setFailed(!await setEnabled(enabled)) }
    finally { setBusy(false) }
  }
  return <div className={css.row}>
    <div>
      <div className={css.title}>{t('settings.visible')}</div>
      <div className={css.description}>{t('settings.hint')}</div>
      {failed && <div role="alert">{t('settings.error')}</div>}
    </div>
    <Switch checked={form.value?.visible === true} disabled={busy || form.status !== 'ready' || !form.writable}
      label={t('settings.visible')} onChange={(enabled) => { void save(enabled) }} />
  </div>
}
