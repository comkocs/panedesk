/** Host-backed external registry path editor for General settings. */
import { useState } from 'react'
import { Button, Input } from '@panedesk/dsh-client-ui-primitives'
import type { ConfigForm } from '@panedesk/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'

/** Editable fields projected from the tree Host configuration. */
export interface RegistrySettings {
  externalRegistryFile: string
}

/** Shared configuration snapshot and revision-aware writer. */
export interface RegistrySettingsFace {
  hooks: { registry: ConfigForm<RegistrySettings> }
  save(path: string): Promise<boolean>
}

/**
 * Edit the host path without reading local browser files.
 * @param props - accepted configuration, writer, and localized copy.
 * @returns one General settings row with explicit save feedback.
 */
export function RegistrySettingsRow({ useRegistry, save, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'subagentTree'> & InjectFace<RegistrySettingsFace>) {
  const form = useRegistry(value => value)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'registrySaved' | 'registrySaveFailed' | null>(null)
  const submit = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const accepted = await save(draft ?? form.value?.externalRegistryFile ?? '')
      setNotice(accepted ? 'registrySaved' : 'registrySaveFailed')
      if (accepted) setDraft(null)
    } catch (_saveFailed) {
      setNotice('registrySaveFailed')
    } finally {
      setBusy(false)
    }
  }
  return <div>
    <label>{t('registryFile')}<Input value={draft ?? form.value?.externalRegistryFile ?? ''}
      disabled={busy || form.status !== 'ready' || !form.writable}
      onChange={event => { setDraft(event.target.value); setNotice(null) }} /></label>
    <p>{t('registryHint')}</p>
    <Button disabled={busy || draft === null || form.status !== 'ready' || !form.writable}
      onClick={() => { void submit() }}>{t('registrySave')}</Button>
    {notice && <p role={notice === 'registrySaveFailed' ? 'alert' : 'status'}>{t(notice)}</p>}
  </div>
}
