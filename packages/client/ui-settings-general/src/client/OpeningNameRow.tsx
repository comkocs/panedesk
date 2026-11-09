/** Panedesk feature settings sample selection, staged writes, and opening-title preview. */
import { useRef, useState } from 'react'
import { Button, Switch } from '@panedesk/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@panedesk/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { ConfigFormSnapshot, SettingsDescribeFace } from '@panedesk/dsh-client-ui-settings/client'
import type { OpeningNamePattern } from '@panedesk/dsh-session-title/types'
import { extractOpeningFolder } from '@panedesk/dsh-session-title/client'
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

/** Keep path anchors relative to the Markdown file rather than its drive or parent directories. */
function selectedPattern(sample: string, a: number, b: number): OpeningNamePattern {
  a += sample.slice(a, b).length - sample.slice(a, b).trimStart().length
  b -= sample.slice(a, b).length - sample.slice(a, b).trimEnd().length
  const markdown = /\.md\b/iu.exec(sample)
  const tail = markdown !== null && a >= markdown.index + markdown[0].length
  let leftStart = tail ? markdown.index : a
  while (!tail && leftStart > 0) {
    const character = sample[leftStart - 1]!
    if (/\s/u.test(character)) {
      if (leftStart === a) {
        leftStart--
        while (leftStart > 0 && !/[\s/\\]/u.test(sample[leftStart - 1]!)) leftStart--
      }
      break
    }
    leftStart--
    if (character === '/' || character === '\\') break
  }
  const space = sample.slice(b).search(/\s/u)
  const rightEnd = space === 0 ? /^\s+\S*/u.exec(sample.slice(b))![0].length : space
  return {
    sample,
    selected: sample.slice(a, b),
    left: sample.slice(leftStart, a),
    right: sample.slice(b, rightEnd < 0 ? sample.length : b + rightEnd),
  }
}

/**
 * Save valid mouse selections immediately and retain drafts on refused writes.
 * @param props - accepted Host configuration, writer, and localized copy.
 * @returns the opening-name editor with immediate local-date preview.
 */
export function OpeningNameRow({ useOpeningName, useDocument, save, setEnabled, openPath, t }: RowProps) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const snapshot = useOpeningName(value => value)
  const documentPath = useDocument(value => value.view?.documentPath)
  const enabled = snapshot.value?.openingNameEnabled ?? true
  const [draft, setDraft] = useState<{ pattern: OpeningNamePattern; revision: number }>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pattern = draft?.pattern ?? snapshot.value?.openingName
  const sample = pattern?.sample ?? ''
  const selected = pattern?.selected ?? ''
  const valid = selected.trim().length > 0
  const writable = snapshot.status === 'ready' && snapshot.writable && !busy
  const date = new Date()
  const folder = extractOpeningFolder(sample)
  const suffix = ` ${date.getMonth() + 1}-${date.getDate()}`
  const folderPreview = (folder ?? t('openingName.untitled')) + suffix
  const preview = enabled
    ? valid ? selected + suffix : folderPreview
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
  const markdown = /\.md\b/iu.exec(sample)
  const fileStart = markdown === null ? 0 : Math.max(sample.lastIndexOf('/', markdown.index), sample.lastIndexOf('\\', markdown.index)) + 1
  const end = markdown === null ? 0 : markdown.index + markdown[0].length
  const folderEnd = fileStart - 1
  const folderStart = Math.max(sample.lastIndexOf('/', folderEnd - 1), sample.lastIndexOf('\\', folderEnd - 1)) + 1
  const choices = [
    { part: 'folder', a: folderStart, b: folderEnd },
    { part: 'file', a: fileStart, b: end - 3 },
    { part: 'after', a: end, b: sample.length },
  ] as const
  const choose = (a: number, b: number): void => {
    textarea.current?.focus()
    textarea.current?.setSelectionRange(a, b)
    const next = selectedPattern(sample, a, b)
    stage(next)
    if (next.selected.length > 0) persist(next)
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
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { run(() => openPath(documentPath, 'open')) }}>{t('openingName.openFile')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { run(() => openPath(documentPath, 'reveal')) }}>{t('openingName.openDirectory')}</Button>
      </div>
    </div>}
    <textarea ref={textarea} id="panedesk-opening-name" className={css.sample} rows={3} value={sample} readOnly={!writable}
      onChange={event => { stage({ sample: event.currentTarget.value, selected: '', left: '', right: '' }) }}
      onSelect={(event) => {
        const { value, selectionStart, selectionEnd } = event.currentTarget
        if (writable && selectionStart !== selectionEnd) {
          const next = selectedPattern(value, selectionStart, selectionEnd)
          if (next.selected === pattern?.selected && next.left === pattern.left && next.right === pattern.right) return
          stage(next)
          if (next.selected.length > 0) persist(next)
        }
      }} />
    <p className={css.description}>{t('openingName.selectionHint')}</p>
    <div className={css.actions}>
      {choices.map(({ part, a, b }) => {
        const candidate = selectedPattern(sample, a, b)
        const active = valid && markdown !== null && candidate.selected === selected
          && candidate.left === pattern?.left && candidate.right === pattern.right
        return <Button key={part} size="sm" variant={active ? 'primary' : 'outline'} aria-pressed={active}
          disabled={!writable || markdown === null || (part === 'folder' && fileStart === 0)}
          onClick={() => { choose(a, b) }}>{t(`openingName.${part}`)}</Button>
      })}
    </div>
    <p className={css.description} aria-live="polite">{t('openingName.preview', { title: preview })}</p>
    <p className={css.description}>{t('openingName.folderPreview', { title: folderPreview })}</p>
    {selected.length > 0 && !valid && <p role="alert">{t('openingName.invalid')}</p>}
    {failed && <p role="alert">{t('openingName.error')}</p>}
    <div className={css.actions}>
      <Button size="sm" variant="primary" disabled={!writable || draft === undefined || !valid}
        onClick={() => { persist(pattern) }}>{t('openingName.save')}</Button>
      <Button size="sm" variant="outline" disabled={!writable || (pattern === undefined && draft === undefined)}
        onClick={() => { persist(undefined) }}>{t('openingName.clear')}</Button>
    </div>
  </div>
}
