/** Panedesk feature settings sample selection, staged writes, and opening-title preview. */
import { useState } from 'react'
import { Button, Switch } from '@panedesk/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@panedesk/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { ConfigFormSnapshot, SettingsDescribeFace } from '@panedesk/dsh-client-ui-settings/client'
import type { OpeningNamePattern } from '@panedesk/dsh-session-title/types'
import css from './OpeningNameRow.module.css'

/** Global preferences owned by the always-mounted settings shell. */
export interface OpeningNameSettings {
  openingNameEnabled: boolean
  openingName?: OpeningNamePattern
}

/** Host configuration read and revision-fenced write supplied through the slot. */
export interface OpeningNameRowInjected {
  hooks: {
    openingName: ObservableSnapshot<ConfigFormSnapshot<OpeningNameSettings>>
    document: SettingsDescribeFace
  }
  setEnabled(enabled: boolean): Promise<boolean>
  openPath(path: string, action: 'open' | 'reveal'): Promise<boolean>
  save(pattern: OpeningNamePattern | undefined, revision: number): Promise<boolean>
}

type RowProps = PropsRuntime<'settings.panedesk.item'> & PropsLocale<'settings'> & InjectFace<OpeningNameRowInjected>

/** Derive anchors from the nearest left separator/whitespace and the next right whitespace. */
function selectedPattern(sample: string, a: number, b: number): OpeningNamePattern {
  let leftStart = a
  while (leftStart > 0) {
    const character = sample[leftStart - 1]!
    if (/\s/u.test(character)) break
    leftStart--
    if (character === '/' || character === '\\') break
  }
  const space = sample.slice(b).search(/\s/u)
  return {
    sample,
    selected: sample.slice(a, b),
    left: sample.slice(leftStart, a),
    right: sample.slice(b, space < 0 ? sample.length : b + space),
  }
}

/**
 * Save valid mouse selections immediately and retain drafts on refused writes.
 * @param props - accepted Host configuration, writer, and localized copy.
 * @returns the opening-name editor with immediate local-date preview.
 */
export function OpeningNameRow({ useOpeningName, useDocument, save, setEnabled, openPath, t }: RowProps) {
  const snapshot = useOpeningName(value => value)
  const documentPath = useDocument(value => value.view?.documentPath)
  const enabled = snapshot.value?.openingNameEnabled ?? true
  const [draft, setDraft] = useState<{ pattern: OpeningNamePattern; revision: number }>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pattern = draft?.pattern ?? snapshot.value?.openingName
  const sample = pattern?.sample ?? ''
  const selected = pattern?.selected ?? ''
  const valid = selected.length > 0 && !/\s/u.test(selected)
  const writable = snapshot.status === 'ready' && snapshot.writable && !busy
  const date = new Date()
  const preview = enabled
    ? `${valid ? selected : t('openingName.automatic')} ${date.getMonth() + 1}-${date.getDate()}`
    : t('openingName.automatic')
  const stage = (next: OpeningNamePattern): void => {
    if (snapshot.revision === undefined) return
    setDraft({ pattern: next, revision: draft?.revision ?? snapshot.revision })
    setFailed(false)
  }
  const persist = (next: OpeningNamePattern | undefined): void => {
    const revision = draft?.revision ?? snapshot.revision
    if (revision === undefined) return
    setBusy(true)
    setFailed(false)
    void save(next, revision).then((accepted) => {
      if (accepted) setDraft(undefined)
      else setFailed(true)
    }).catch(() => { setFailed(true) }).finally(() => { setBusy(false) })
  }
  const run = (action: () => Promise<boolean>): void => {
    setBusy(true)
    setFailed(false)
    void action().then(accepted => { setFailed(!accepted) })
      .catch(() => { setFailed(true) }).finally(() => { setBusy(false) })
  }
  return <div className={css.row}>
    <label className={css.title} htmlFor="panedesk-opening-name">{t('openingName.title')}</label>
    <p className={css.description}>{t('openingName.description')}</p>
    <p className={css.description}>{t('openingName.scope')}</p>
    <Switch checked={enabled} disabled={!writable} label={t('openingName.enabled')}
      onChange={next => { run(() => setEnabled(next)) }} />
    {documentPath && <div>
      <p className={css.description}>{t('openingName.config', { path: documentPath })}</p>
      <p className={css.description}>{t('openingName.directory', { path: documentPath.replace(/[\\/][^\\/]*$/u, '') })}</p>
      <div className={css.actions}>
        <Button size="sm" disabled={busy} onClick={() => { run(() => openPath(documentPath, 'open')) }}>{t('openingName.openFile')}</Button>
        <Button size="sm" disabled={busy} onClick={() => { run(() => openPath(documentPath, 'reveal')) }}>{t('openingName.openDirectory')}</Button>
      </div>
    </div>}
    <textarea id="panedesk-opening-name" className={css.sample} rows={3} value={sample} disabled={!writable}
      onChange={event => { stage({ sample: event.currentTarget.value, selected: '', left: '', right: '' }) }}
      onSelect={(event) => {
        const { value, selectionStart, selectionEnd } = event.currentTarget
        if (selectionStart !== selectionEnd) {
          const next = selectedPattern(value, selectionStart, selectionEnd)
          stage(next)
          if (next.selected.length > 0 && !/\s/u.test(next.selected)) persist(next)
        }
      }} />
    <p className={css.description} aria-live="polite">{t('openingName.preview', { title: preview })}</p>
    {selected.length > 0 && !valid && <p role="alert">{t('openingName.invalid')}</p>}
    {failed && <p role="alert">{t('openingName.error')}</p>}
    <div className={css.actions}>
      <Button size="sm" disabled={!writable || draft === undefined || !valid}
        onClick={() => { persist(pattern) }}>{t('openingName.save')}</Button>
      <Button size="sm" variant="ghost" disabled={!writable || (pattern === undefined && draft === undefined)}
        onClick={() => { persist(undefined) }}>{t('openingName.clear')}</Button>
    </div>
  </div>
}
