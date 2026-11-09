/** Product-owned preset editing and selection without automatic submission. */
import { useState } from 'react'
import { Button, Menu, Modal, SettingsPageHeader } from '@panedesk/dsh-client-ui-primitives'
import type { MenuEntry } from '@panedesk/dsh-client-ui-primitives'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { OpeningPreset } from '../types.ts'
import { presetName } from '../preset-name.ts'
import type { PresetsProps, PresetSettingsProps, PresetPickerProps, PresetQuickProps } from './preset-props.ts'
import css from './OpeningPresets.module.css'

/** Editable local rows are persisted atomically through the shared product form. */
function Editor(props: PresetsProps & { initial: OpeningPreset[]; revision: number | undefined; done: () => void }) {
  const { t } = props
  const [rows, setRows] = useState(props.initial)
  const [paste, setPaste] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragged, setDragged] = useState<number>()
  const update = (index: number, patch: Partial<OpeningPreset>) => setRows(current => current.map((row, at) => at === index ? { ...row, ...patch } : row))
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <div className={css.editor}>
    {rows.map((row, index) => <fieldset key={index} className={css.row} draggable={!busy}
      onDragStart={event => { if ((event.target as HTMLElement).tagName !== 'FIELDSET') return; setDragged(index) }}
      onDragOver={event => event.preventDefault()} onDrop={event => {
        event.preventDefault(); event.stopPropagation()
        if (event.dataTransfer.files.length) {
          update(index, { directories: [...new Set([...row.directories, ...props.droppedPaths(Array.from(event.dataTransfer.files))])] })
        } else if (dragged !== undefined) {
          const next = [...rows]; const [moved] = next.splice(dragged, 1); next.splice(index, 0, moved!); setRows(next)
        }
        setDragged(undefined)
      }}>
      <legend>{row.name || t('addPreset')}</legend>
      <label>{t('presetPrompt')}<textarea value={row.prompt} onChange={event => {
        const prompt = event.target.value
        update(index, { prompt, ...(row.name === '' || row.name === props.namePreset(row.prompt) ? { name: props.namePreset(prompt) } : {}) })
      }} /></label>
      <label>{t('presetName')}<input value={row.name} onChange={event => update(index, { name: presetName(event.target.value) })} /></label>
      <label>{t('presetDirectories')}<textarea value={row.directories.join('\n')} placeholder={t('dropDirectories')}
        onChange={event => update(index, { directories: event.target.value.split('\n') })} /></label>
      <Button variant="outline" onClick={() => void run(async () => {
        const directory = await props.pickDirectory()
        if (directory) update(index, { directories: [...new Set([...row.directories.filter(Boolean), directory])] })
      })}>{t('addDirectory')}</Button>
      <label>{t('presetModel')}<input value={row.model ?? ''} placeholder={t('followCurrent')}
        onChange={event => update(index, { model: event.target.value })} /></label>
      <label>{t('presetPermission')}<input value={row.permission ?? ''} placeholder={t('followCurrent')}
        onChange={event => update(index, { permission: event.target.value })} /></label>
      <Button variant="outline" onClick={() => setRows(rows.filter((_, at) => at !== index))}>{t('deletePreset')}</Button>
    </fieldset>)}
    <p>{t('reorderPresets')}</p>
    <Button variant="outline" onClick={() => setRows([...rows, { name: '', prompt: '', directories: [] }])}>{t('addPreset')}</Button>
    <label>{t('importText')}<textarea value={paste} onChange={event => setPaste(event.target.value)} /></label>
    <div className={css.actions}>{([false, true] as const).map(table => <Button key={String(table)} variant="outline" disabled={busy}
      onClick={() => void run(async () => { setRows([...rows, ...await props.importPresets(paste, table)]) })}>
      {t(table ? 'importTable' : 'batchPaste')}</Button>)}</div>
    <Button disabled={busy || rows.some(row => !row.name.trim() || !row.prompt.trim() || !row.directories.some(path => path.trim()))}
      onClick={() => void run(async () => {
        const saved = rows.map(row => ({ name: presetName(row.name), prompt: row.prompt,
          directories: row.directories.map(path => path.trim()).filter(Boolean),
          ...(row.model?.trim() ? { model: row.model.trim() } : {}), ...(row.permission?.trim() ? { permission: row.permission.trim() } : {}) }))
        if (!await props.savePresets(saved, props.revision)) throw new Error(t('presetSaveFailed'))
        props.done()
      })}>{t('save')}</Button>
    {error && <p role="alert">{error}</p>}
  </div>
}

/** Shared settings and quick-panel management controls. */
function Management(props: PresetsProps) {
  const form = props.usePresets(value => value)
  const [editing, setEditing] = useState(false)
  return <>
    <Button variant="outline" disabled={form.status !== 'ready' || !form.writable} onClick={() => setEditing(true)}>{props.t('editPresets')}</Button>
    <Modal open={editing} title={props.t('presetsTitle')} closeLabel={props.t('close')} onClose={() => setEditing(false)}>
      {editing && <Editor {...props} initial={form.value?.openingPresets ?? []} revision={form.revision} done={() => setEditing(false)} />}
    </Modal>
  </>
}

/** Render the product settings page and its actual configuration document location.
 * @param props - shared form, native actions, and localized copy.
 * @returns Opening preset management page.
 */
export function OpeningPresetSettings(props: PresetSettingsProps) {
  const { t } = props
  const path = props.useDocument(state => state.view?.documentPath)
  const presets = props.usePresets(state => state.value?.openingPresets ?? [])
  const [error, setError] = useState('')
  return <section className={css.editor}>
    <SettingsPageHeader what={t('presetsWhat')} whether={t('presetsWhether')} ai={t('presetsAi')}
      labels={{ what: t('headerWhat'), whether: t('headerWhether'), ai: t('headerAi'), copy: t('copy'), copied: t('copied'), copyFailed: t('copyFailed'), once: t('once') }} />
    <p>{t('settingsFile')}: <code>{path}</code> <Button variant="outline" onClick={() => {
      void props.openDocument().catch(reason => setError(String(reason)))
    }}>{t('openFile')}</Button></p>
    <ul>{presets.map((preset, index) => <li key={index}>{preset.name} — {preset.directories.join(', ')}</li>)}</ul>
    <Management {...props} />
    {error && <p role="alert">{error}</p>}
  </section>
}

/** Selector rows prioritize the current directory; other presets are grouped by directory. */
function Picker(props: PresetsProps & { currentDirectory: string | undefined; sessionId: SessionId | undefined }) {
  const presets = props.usePresets(state => state.value?.openingPresets ?? [])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const matches = (preset: OpeningPreset) => props.currentDirectory !== undefined && preset.directories.includes(props.currentDirectory)
  const item = (preset: OpeningPreset, index: number) => ({ id: String(index), label: preset.name,
    ...(!matches(preset) && preset.directories.length > 1 ? { submenu: preset.directories.map((directory, at) => ({ id: `${index}:${at}`, label: directory })) } : {}) })
  const items: MenuEntry[] = presets.flatMap((preset, index) => matches(preset) ? [item(preset, index)] : [])
  const directories = [...new Set(presets.filter(preset => !matches(preset)).map(preset => preset.directories[0]!))]
  for (const directory of directories) {
    items.push({ type: 'label', id: `directory:${directory}`, text: directory })
    presets.forEach((preset, index) => { if (!matches(preset) && preset.directories[0] === directory) items.push(item(preset, index)) })
  }
  items.push({ type: 'separator', id: 'manage-separator' }, { id: 'manage', label: props.t('managePresets') })
  return <>
    <Menu open={open} onClose={() => setOpen(false)} items={items} portal
      anchor={<Button variant="ghost" disabled={busy} onClick={() => setOpen(!open)}>{props.t('opening')}</Button>}
      onSelect={id => {
        setOpen(false)
        if (id === 'manage') { props.managePresets(); return }
        const [index, at] = id.split(':').map(Number)
        const preset = presets[index!]!
        const directory = at === undefined && matches(preset) ? props.currentDirectory! : preset.directories[at ?? 0]!
        setBusy(true); setError('')
        void props.choosePreset(index!, directory, directory === props.currentDirectory ? props.sessionId : undefined).catch(reason => setError(String(reason))).finally(() => setBusy(false))
      }} />
    {error && <p role="alert">{error}</p>}
  </>
}

/** Opening control at the previous mode-picker position.
 * @param props - current directory, shared presets, and actions.
 * @returns Preset menu; selection never submits a prompt.
 */
export function OpeningPresetPicker(props: PresetPickerProps) { return <Picker {...props} /> }

/** New-session quick panel shares settings management and the opening selector.
 * @param props - session hooks and shared feature actions.
 * @returns Quick-management entry and panel.
 */
export function OpeningPresetQuick(props: PresetQuickProps) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const session = props.useSessions(snapshot => snapshot.byId[props.sessionId])
  const directory = session?.cwd
  if (!session?.blank) return null
  return <>
    <Button variant="ghost" onClick={() => setOpen(true)}>{props.t('presetsTitle')}</Button>
    {error && <p role="alert">{error}</p>}
    <Modal open={open} title={props.t('presetsTitle')} closeLabel={props.t('close')} onClose={() => setOpen(false)}>
      <Picker {...props} currentDirectory={directory} choosePreset={(index, path, sessionId) => {
        setOpen(false)
        setError('')
        return props.choosePreset(index, path, sessionId).catch(reason => { setError(String(reason)) })
      }} />
      <Management {...props} />
      <Button variant="outline" onClick={() => { setOpen(false); props.managePresets() }}>{props.t('managePresets')}</Button>
    </Modal>
  </>
}
