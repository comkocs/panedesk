/** Host-backed external registry path editor for Panedesk feature settings. */
import { useState } from 'react'
import { Button, Input, Switch } from '@panedesk/dsh-client-ui-primitives'
import type { ConfigForm, SettingsDescribeFace } from '@panedesk/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'

/** Editable fields projected from the tree Host configuration. */
export interface RegistrySettings {
  externalRegistryFile: string
  externalRegistryEnabled: boolean
}

/** Shared configuration snapshot, native actions, and revision-aware writer. */
export interface RegistrySettingsFace {
  hooks: { registry: ConfigForm<RegistrySettings>; document: SettingsDescribeFace }
  save(path: string): Promise<boolean>
  setEnabled(enabled: boolean): Promise<boolean>
  chooseFile: (() => Promise<string | null>) | undefined
  openPath(path: string, action: 'open' | 'reveal'): Promise<boolean>
}

/**
 * Edit a global Host registry path; native file selection saves and enables it.
 * @param props - accepted configuration, native actions, writer, and localized copy.
 * @returns one Panedesk feature settings row with explicit action feedback.
 */
export function RegistrySettingsRow({ useRegistry, useDocument, save, setEnabled, chooseFile, openPath, t }:
  PropsRuntime<'settings.panedesk.item'> & PropsLocale<'subagentTree'> & InjectFace<RegistrySettingsFace>) {
  const form = useRegistry(value => value)
  const documentPath = useDocument(value => value.view?.documentPath)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'registrySaved' | 'registrySaveFailed' | 'registryActionFailed' | null>(null)
  const path = draft ?? form.value?.externalRegistryFile ?? ''
  const writable = !busy && form.status === 'ready' && form.writable
  const run = async (action: () => Promise<boolean | null>, failure: 'registrySaveFailed' | 'registryActionFailed'): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const accepted = await action()
      if (accepted !== null) setNotice(accepted ? 'registrySaved' : failure)
    } catch (_actionFailed) {
      setNotice(failure)
    } finally {
      setBusy(false)
    }
  }
  const persist = async (next: string): Promise<boolean> => {
    const accepted = await save(next)
    if (accepted) setDraft(current => current === next ? null : current)
    return accepted
  }
  return <div>
    <h3>{t('registryFile')}</h3>
    <p>{t('registryHint')}</p>
    <h4>{t('registryOnce')}</h4>
    <ol><li>{t('registryStep1')}</li><li>{t('registryStep2')}</li><li>{t('registryStep3')}</li></ol>
    <p>{t('registryAI')}</p>
    <p>{t('registryScope')}</p>
    <Switch checked={form.value?.externalRegistryEnabled ?? false} disabled={!writable || path === ''}
      label={t('registryEnabled')} onChange={next => { void run(() => setEnabled(next), 'registrySaveFailed') }} />
    <label>{t('registryPath')}<Input value={path} disabled={!writable}
      onChange={event => {
        const next = event.target.value
        setDraft(next)
        setNotice(null)
        void persist(next).then(accepted => { if (!accepted) setNotice('registrySaveFailed') })
          .catch(() => { setNotice('registrySaveFailed') })
      }} /></label>
    <div>
      {chooseFile && <Button variant="outline" disabled={!writable} onClick={() => {
        void run(async () => {
          const selected = await chooseFile()
          if (selected === null) return null
          setDraft(selected)
          return persist(selected)
        }, 'registryActionFailed')
      }}>{t('registryChoose')}</Button>}
      <Button variant="outline" disabled={busy || path === ''} onClick={() => {
        void run(() => openPath(path, 'open'), 'registryActionFailed')
      }}>{t('registryOpenFile')}</Button>
      <Button variant="outline" disabled={busy || path === ''} onClick={() => {
        void run(() => openPath(path, 'reveal'), 'registryActionFailed')
      }}>{t('registryOpenDirectory')}</Button>
    </div>
    {path !== '' && <p>{t('registryDirectory', { path: path.replace(/[\\/][^\\/]*$/u, '') })}</p>}
    {documentPath && <div>
      <p>{t('registryConfig', { path: documentPath })}</p>
      <p>{t('registryDirectory', { path: documentPath.replace(/[\\/][^\\/]*$/u, '') })}</p>
      <Button variant="outline" disabled={busy} onClick={() => {
        void run(() => openPath(documentPath, 'open'), 'registryActionFailed')
      }}>{t('registryOpenFile')}</Button>
      <Button variant="outline" disabled={busy} onClick={() => {
        void run(() => openPath(documentPath, 'reveal'), 'registryActionFailed')
      }}>{t('registryOpenDirectory')}</Button>
    </div>}
    {notice && <p role={notice === 'registrySaved' ? 'status' : 'alert'}>{t(notice)}</p>}
  </div>
}
