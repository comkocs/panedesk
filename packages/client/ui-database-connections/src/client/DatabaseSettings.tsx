/** Connection editor: secret drafts remain local and are never returned by inspection. */
import { useState } from 'react'
import { Button } from '@panedesk/dsh-client-ui-primitives'
import type { ConnectionInput } from '@panedesk/dsh-db-connections/types'
import type { DatabaseKey } from './locales.ts'
import type { DatabaseProps, KeyListing } from './props.ts'
import css from './DatabaseSettings.module.css'

const fresh = (): ConnectionInput => ({ name: '', host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres',
  ssl: false, modelEnabled: false, ssh: { enabled: false, host: '', port: 22, user: '', privateKeyPath: '' } })

/** Render settings through the standard Panedesk section slot. */
export function DatabaseSettings({ useInspection, refresh, save, remove, test, browse, open, t }: DatabaseProps) {
  const state = useInspection(value => value)
  const [draft, setDraft] = useState<ConnectionInput | null>(null)
  const [uri, setUri] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<DatabaseKey | null>(null)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [listing, setListing] = useState<KeyListing | null>(null)
  const [directory, setDirectory] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [clearPassphrase, setClearPassphrase] = useState(false)
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setMessage(null); setError('')
    try { await operation() }
    catch (error) { setMessage('failure'); setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const edit = (input: ConnectionInput) => {
    setDraft(input); setUri(''); setListing(null); setError(''); setMessage(null)
    setClearPassword(false); setClearPassphrase(false)
  }
  const input = (): ConnectionInput => {
    if (!draft) throw new Error('No connection selected')
    return { ...draft,
      ...(clearPassword ? { password: '' } : draft.password ? { password: draft.password } : {}),
      ...(clearPassphrase ? { passphrase: '' } : draft.passphrase ? { passphrase: draft.passphrase } : {}) }
  }
  const paste = (value: string) => {
    setUri(value)
    if (!value.trim() || !draft) return
    try {
      const parsed = new URL(value.trim())
      const mode = parsed.searchParams.get('sslmode')
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash
        || [...parsed.searchParams.keys()].some(key => key !== 'sslmode')
        || (mode !== null && !['disable', 'require', 'verify-ca', 'verify-full'].includes(mode))) throw new Error()
      const password = decodeURIComponent(parsed.password)
      setDraft({ ...draft, host: parsed.hostname.replace(/^\[|\]$/g, ''), port: Number(parsed.port || 5432),
        user: decodeURIComponent(parsed.username || 'postgres'), database: decodeURIComponent(parsed.pathname.slice(1) || 'postgres'),
        ssl: mode !== null && mode !== 'disable', password })
      setClearPassword(password.length === 0)
      setUri(''); setError(''); setMessage(null)
    } catch (_error) { setMessage('uriError'); setError('') }
  }
  const browseDirectory = async (path: string) => {
    const next = await browse(path)
    setListing(next); setDirectory(next.path)
  }
  const textField = (key: 'name' | 'host' | 'user' | 'database' | 'password' | 'passphrase') => <label className={css.field} key={key}>
    {t(key)}<input autoComplete="off" type={key === 'password' || key === 'passphrase' ? 'password' : 'text'}
      value={draft?.[key] ?? ''} onChange={event => { if (draft) {
        const value = event.target.value
        if ((key === 'password' || key === 'passphrase') && !value) {
          const next = { ...draft }; delete next[key]; setDraft(next)
        } else setDraft({ ...draft, [key]: value })
      } }} />
  </label>
  return <div className={css.page}>
    <h2>{t('title')}</h2><p>{t('intro')}</p><p>{t('defaults')}</p><p>{t('hostHint')}</p><p>{t('permission')}</p>
    <section className={css.section}>
      <h3>{t('configuration')}</h3><p className={css.path}>{state.filename}</p>
      <div className={css.actions}>
        <Button variant="outline" disabled={busy || !state.filename} onClick={() => { void run(() => open(state.filename)) }}>{t('open')}</Button>
        <Button variant="outline" disabled={busy || state.loading} onClick={() => { void run(refresh) }}>{t('refresh')}</Button>
      </div>
      {state.loading && <p role="status">{t('loading')}</p>}
      {state.error && <p role="alert">{t('failure')} {state.error}</p>}
    </section>
    <section className={css.section}>
      {!state.connections.length && !state.loading && <p>{t('empty')}</p>}
      {state.connections.map(row => <div key={row.id} className={css.section}>
        <strong>{row.name}</strong>
        <label><input type="checkbox" checked={row.modelEnabled} disabled={busy || state.loading}
          onChange={event => { const enabled = event.target.checked; void run(() => save({ ...row, modelEnabled: enabled })) }} /> {t('modelEnabled')}</label>
        <div className={css.actions}>
          <Button variant="outline" disabled={busy} onClick={() => edit(row)}>{t('edit')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => setDeleting(row.id)}>{t('remove')}</Button>
          {deleting === row.id && <><span>{t('confirmDelete')}</span>
            <Button variant="outline" disabled={busy} onClick={() => { void run(async () => { await remove(row.id); setDeleting(null); if (draft?.id === row.id) setDraft(null) }) }}>{t('remove')}</Button>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>{t('cancel')}</Button></>}
        </div>
      </div>)}
      <Button variant="outline" disabled={busy || state.loading} onClick={() => edit(fresh())}>{t('add')}</Button>
    </section>
    {draft && <form className={css.section} onSubmit={event => { event.preventDefault(); void run(async () => {
      if (uri.trim()) { setMessage('uriError'); return }
      await save(input()); setDraft(null); setUri(''); setMessage('saved')
    }) }}>
      <fieldset disabled={busy} className={css.section}>
        <label className={css.field}>{t('uri')}<input type="password" autoComplete="off" value={uri} onChange={event => paste(event.target.value)} /></label>
        <div className={css.fields}>
          {textField('name')}{textField('host')}
          <label className={css.field}>{t('port')}<input type="number" min={1} max={65535} value={draft.port} onChange={event => setDraft({ ...draft, port: Number(event.target.value) })} /></label>
          {textField('user')}{textField('password')}{textField('database')}
        </div>
        <p>{t('secretHint')}</p>
        <label><input type="checkbox" checked={clearPassword} onChange={event => setClearPassword(event.target.checked)} /> {t('clearPassword')}</label>
        <label><input type="checkbox" checked={draft.ssl} onChange={event => setDraft({ ...draft, ssl: event.target.checked })} /> {t('ssl')}</label>
        <label><input type="checkbox" checked={draft.modelEnabled} onChange={event => setDraft({ ...draft, modelEnabled: event.target.checked })} /> {t('modelEnabled')}</label>
        <label><input type="checkbox" checked={draft.ssh.enabled} onChange={event => setDraft({ ...draft, ssh: { ...draft.ssh, enabled: event.target.checked } })} /> {t('sshEnabled')}</label>
        {draft.ssh.enabled && <>
          <div className={css.fields}>
            {(['host', 'user', 'privateKeyPath'] as const).map(key => <label className={css.field} key={key}>
              {t(key === 'host' ? 'sshHost' : key === 'user' ? 'sshUser' : 'privateKeyPath')}
              <input value={draft.ssh[key]} onChange={event => setDraft({ ...draft, ssh: { ...draft.ssh, [key]: event.target.value } })} />
            </label>)}
            <label className={css.field}>{t('sshPort')}<input type="number" min={1} max={65535} value={draft.ssh.port}
              onChange={event => setDraft({ ...draft, ssh: { ...draft.ssh, port: Number(event.target.value) } })} /></label>
            {textField('passphrase')}
          </div>
          <label><input type="checkbox" checked={clearPassphrase} onChange={event => setClearPassphrase(event.target.checked)} /> {t('clearPassphrase')}</label>
          <Button variant="outline" type="button" onClick={() => { void run(() => browseDirectory('')) }}>{t('browse')}</Button>
          {listing && <div className={css.section}>
            <label className={css.field}>{t('directory')}<input value={directory} onChange={event => setDirectory(event.target.value)} /></label>
            <div className={css.actions}>
              <Button variant="outline" type="button" onClick={() => { void run(() => browseDirectory(directory)) }}>{t('go')}</Button>
              <Button variant="outline" type="button" onClick={() => { void run(() => browseDirectory(listing.parent)) }}>{t('parent')}</Button>
              <Button variant="outline" type="button" onClick={() => setListing(null)}>{t('cancel')}</Button>
            </div>
            <div className={css.list}>{listing.entries.map(entry => <Button variant="outline" type="button" key={entry.path} onClick={() => {
              if (entry.directory) void run(() => browseDirectory(entry.path))
              else { setDraft({ ...draft, ssh: { ...draft.ssh, privateKeyPath: entry.path } }); setListing(null) }
            }}>{entry.name}{entry.directory ? '/' : ''}</Button>)}</div>
          </div>}
        </>}
        <div className={css.actions}>
          <Button variant="primary" type="submit">{t('save')}</Button>
          <Button variant="outline" type="button" onClick={() => { void run(async () => {
            if (uri.trim()) { setMessage('uriError'); return }
            setMessage('testing')
            const result = await test(input()); setMessage(result.ok ? 'testOk' : 'testFailed'); setError(result.error ?? '')
          }) }}>{t('test')}</Button>
          <Button variant="outline" type="button" onClick={() => { setDraft(null); setUri(''); setListing(null) }}>{t('cancel')}</Button>
        </div>
      </fieldset>
    </form>}
    {message && <p role={error || message === 'uriError' ? 'alert' : 'status'}>{t(message)}</p>}
    {error && <pre className={css.error} role="alert">{error}</pre>}
  </div>
}
