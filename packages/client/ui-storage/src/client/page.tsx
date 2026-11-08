/** Host-scoped connection form; password drafts are never persisted by the browser. */
import { useState } from 'react'
import { Button, Input, Switch } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { StorageSettings } from '@panedesk/dsh-storage-postgres/types'
import type { StorageActions } from './index.ts'
import css from './page.module.css'

type Props = PropsRuntime<'settings.section'> & PropsLocale<'dataStorage'> & InjectFace<StorageActions>

export function StorageSettingsPage({ useResource, save, test, migrate, open, t }: Props) {
  const [revision, setRevision] = useState(0)
  const resource = useResource<'data-storage'>(`dsh-resource://data-storage/current?revision=${revision}`)
  const [draft, setDraft] = useState<StorageSettings | null>(null)
  const [password, setPassword] = useState<string | undefined>()
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
  const change = <K extends keyof StorageSettings>(key: K, value: StorageSettings[K]) => {
    if (settings) setDraft({ ...settings, [key]: value })
  }
  const input = () => ({ settings: settings!, ...password === undefined ? {} : { password } })
  return <section className={css.page}>
    <h2>{t('title')}</h2><p>{t('intro')}</p>
    <h3>{t('backend')}</h3>
    <div className={css.controls}>{(['local', 'postgres'] as const).map(backend =>
      <Button key={backend} disabled={busy || !settings} variant={settings?.backend === backend ? 'primary' : 'outline'}
        aria-pressed={settings?.backend === backend} onClick={() => change('backend', backend)}>{t(backend)}</Button>)}</div>
    <p>{t('defaults')}</p><p>{t('restart')}</p>
    {status && <p>{t('active')}: {t(status.active)}</p>}
    {status?.error && <p role="alert">{status.active === 'local' && status.settings.backend === 'postgres' ? t('fallback') : t('failed')} {status.error}</p>}
    <h3>{t('configuration')}</h3><code>{status?.configPath ?? t('loading')}</code>
    <div className={css.controls}>
      <Button disabled={busy || !status} onClick={() => { void perform(async () => { if (!await open(status!.configPath, false)) throw new Error(t('error')) }) }}>{t('open')}</Button>
      <Button disabled={busy || !status} onClick={() => { void perform(async () => { if (!await open(status!.configPath, true)) throw new Error(t('error')) }) }}>{t('openFolder')}</Button>
    </div>
    <h3>{t('scope')}</h3><p>{t('scopeHint')}</p>
    <div className={css.fields}>
      {(['host', 'database', 'user'] as const).map(key => <label key={key}>{t(key)}<Input disabled={busy || !settings}
        value={settings?.[key] ?? ''} onChange={event => change(key, event.currentTarget.value)} /></label>)}
      <label>{t('port')}<Input type="number" min={1} max={65535} step={1} disabled={busy || !settings}
        value={settings?.port ?? 5432} onChange={event => change('port', event.currentTarget.valueAsNumber)} /></label>
      <label>{t('password')}<Input type="password" autoComplete="new-password" disabled={busy || !settings}
        value={password ?? ''} onChange={event => setPassword(event.currentTarget.value)} /></label>
      <Switch label={t('ssl')} checked={settings?.ssl ?? false} disabled={busy || !settings} onChange={value => change('ssl', value)} />
    </div>
    <p>{t('passwordHint')} {status && t(status.hasPassword ? 'passwordSaved' : 'passwordEmpty')}</p>
    <div className={css.controls}>
      <Button disabled={busy || !settings} onClick={() => { void perform(async () => {
        const result = await save(input())
        if (!result.ok) throw new Error(result.error.message)
        setPassword(undefined); setDraft(null); setRevision(value => value + 1); setMessage(t('saved'))
      }) }}>{t('save')}</Button>
      <Button disabled={busy || !settings} onClick={() => { void perform(async () => {
        const result = await test(input())
        if (!result.ok) throw new Error(result.error.message)
        setMessage(result.value.connected ? t('connected') : `${t('failed')}: ${result.value.error}`)
      }) }}>{t('test')}</Button>
      <Button disabled={busy} onClick={() => { setRevision(value => value + 1) }}>{t('refresh')}</Button>
    </div>
    <p>{t('migrationHint')}</p>
    <Button disabled={busy || !status || draft !== null || password !== undefined} onClick={() => { void perform(async () => {
      const result = await migrate()
      if (!result.ok) throw new Error(result.error.message)
      setMessage(t('copied', { count: result.value })); setRevision(value => value + 1)
    }) }}>{t('migrate')}</Button>
    {status?.restartRequired && <p role="status">{t('restart')}</p>}
    {resource.status === 'failed' && <p role="alert">{t('error')}</p>}
    {message && <p role="status">{message}</p>}
  </section>
}
