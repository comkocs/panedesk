/** Host-scoped storage selection from saved database connections. */
import { useState } from 'react'
import { Button } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { StorageSettings } from '@panedesk/dsh-storage-postgres/types'
import type { StorageActions } from './index.ts'
import css from './page.module.css'

type Props = PropsRuntime<'settings.section'> & PropsLocale<'dataStorage'> & InjectFace<StorageActions>

export function StorageSettingsPage({ useResource, save, test, migrate, open, t }: Props) {
  const [revision, setRevision] = useState(0)
  const resource = useResource<'data-storage'>(`dsh-resource://data-storage/current?revision=${revision}`)
  const [draft, setDraft] = useState<StorageSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const status = resource.value
  const settings = draft ?? status?.settings
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setMessage(null)
    try { await operation() }
    catch (error) { setMessage(error instanceof Error ? error.message : t('error')) }
    finally { setBusy(false) }
  }
  const input = () => ({ settings: settings! })
  return <section className={css.page}>
    <h2>{t('title')}</h2><p>{t('intro')}</p>
    <h3>{t('backend')}</h3>
    <div className={css.controls}>
      <Button disabled={busy || !settings} variant={settings?.backend === 'local' ? 'primary' : 'outline'}
        aria-pressed={settings?.backend === 'local'} onClick={() => setDraft({ backend: 'local', connectionId: '' })}>{t('local')}</Button>
      {status?.connections.map(connection => <Button key={connection.id} disabled={busy || !settings}
        variant={settings?.backend === 'postgres' && settings.connectionId === connection.id ? 'primary' : 'outline'}
        aria-pressed={settings?.backend === 'postgres' && settings.connectionId === connection.id}
        onClick={() => setDraft({ backend: 'postgres', connectionId: connection.id })}>{connection.name}</Button>)}
    </div>
    <p>{t('connectionsHint')}</p>
    <p>{t('defaults')}</p><p>{t('restart')}</p>
    {status && <p>{t('active')}: {t(status.active)}</p>}
    {status?.error && <p role="alert">{status.active === 'local' && status.settings.backend === 'postgres' ? t('fallback') : t('failed')} {status.error}</p>}
    <h3>{t('configuration')}</h3><code>{status?.configPath ?? t('loading')}</code>
    <div className={css.controls}>
      <Button variant="outline" disabled={busy || !status} onClick={() => { void perform(async () => { if (!await open(status!.configPath, false)) throw new Error(t('error')) }) }}>{t('open')}</Button>
      <Button variant="outline" disabled={busy || !status} onClick={() => { void perform(async () => { if (!await open(status!.configPath, true)) throw new Error(t('error')) }) }}>{t('openFolder')}</Button>
    </div>
    <h3>{t('scope')}</h3><p>{t('scopeHint')}</p>
    <div className={css.controls}>
      <Button variant="primary" disabled={busy || !settings} onClick={() => { void perform(async () => {
        const result = await save(input())
        if (!result.ok) throw new Error(result.error.message)
        setDraft(null); setRevision(value => value + 1); setMessage(t('saved'))
      }) }}>{t('save')}</Button>
      <Button variant="outline" disabled={busy || settings?.backend !== 'postgres'} onClick={() => { void perform(async () => {
        const result = await test(input())
        if (!result.ok) throw new Error(result.error.message)
        setMessage(result.value.connected ? t('connected') : `${t('failed')}: ${result.value.error}`)
      }) }}>{t('test')}</Button>
      <Button variant="outline" disabled={busy} onClick={() => { setRevision(value => value + 1) }}>{t('refresh')}</Button>
    </div>
    <p>{t('migrationHint')}</p>
    <Button variant="outline" disabled={busy || status?.settings.backend !== 'postgres' || draft !== null} onClick={() => { void perform(async () => {
      const result = await migrate()
      if (!result.ok) throw new Error(result.error.message)
      setMessage(t('copied', { count: result.value })); setRevision(value => value + 1)
    }) }}>{t('migrate')}</Button>
    {status?.restartRequired && <p role="status">{t('restart')}</p>}
    {resource.status === 'failed' && <p role="alert">{t('error')}</p>}
    {message && <p role="status">{message}</p>}
  </section>
}
