/** Optional external Chrome attachment settings, separate from the sidebar guest. */
import { useState, type ReactNode } from 'react'
import { Button, Input, Switch } from '@panedesk/dsh-client-ui-primitives'
import type { ConfigForm } from '@panedesk/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'

/** Editable fields in the desktop Chrome provider entry. */
export interface ChromePreferences { enabled: boolean; endpoint: string }
/** Shared settings mirror and its serialized writes. */
export interface ChromeSettingsInjected {
  hooks: { preferences: ConfigForm<ChromePreferences> }
  setPreference(field: keyof ChromePreferences, value: boolean | string): Promise<boolean>
}
type Props = PropsRuntime<'settings.section'> & PropsLocale<'sidebarBrowser'> & InjectFace<ChromeSettingsInjected>

/** @param props - framework settings hooks and localized controls. @returns Chrome attachment controls. */
export function ChromeSettings({ usePreferences, setPreference, t }: Props): ReactNode {
  const preferences = usePreferences(value => value)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const save = async (field: keyof ChromePreferences, value: boolean | string): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try { setFailed(!await setPreference(field, value)) }
    catch (_error) { setFailed(true) }
    finally { setBusy(false) }
  }
  const disabled = busy || !preferences.writable || preferences.value === undefined
  return <section>
    <h2>{t('chrome.title')}</h2>
    <p>{t('chrome.description')}</p>
    <Switch label={t('chrome.enabled')} checked={preferences.value?.enabled ?? false} disabled={disabled}
      onChange={enabled => { void save('enabled', enabled) }} />
    <label>{t('chrome.endpoint')}<Input value={endpoint ?? preferences.value?.endpoint ?? ''} disabled={disabled}
      onChange={event => { setEndpoint(event.currentTarget.value) }} /></label>
    <Button variant="outline" disabled={disabled || endpoint === null}
      onClick={() => { if (endpoint !== null) void save('endpoint', endpoint) }}>{t('chrome.save')}</Button>
    {failed && <p role="alert">{t('chrome.saveError')}</p>}
  </section>
}
