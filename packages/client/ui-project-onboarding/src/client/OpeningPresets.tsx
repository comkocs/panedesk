/** Product-owned preset editing and selection without automatic submission. */
import { useState } from 'react'
import { Button, Menu, Modal, SettingsPageHeader, Toast } from '@panedesk/dsh-client-ui-primitives'
import type { MenuEntry } from '@panedesk/dsh-client-ui-primitives'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { OpeningPreset } from '../types.ts'
import { presetName } from '../preset-name.ts'
import { importPresets } from './preset-import.ts'
import type { PresetsProps, PresetSettingsProps, PresetPickerProps, PresetQuickProps } from './preset-props.ts'
import css from './OpeningPresets.module.css'

/** Editable local rows are persisted atomically through the shared product form. */
function Editor(props: PresetsProps & { initial: OpeningPreset[]; expandFirst?: boolean; revision: number | undefined; done: (count: number) => void }) {
  const { t } = props
  const [rows, setRows] = useState(() => props.initial.map((row, index) => ({ ...row, id: crypto.randomUUID(), expanded: Boolean(props.expandFirst && index === 0) })))
  const [split, setSplit] = useState<{ before: typeof rows; count: number }>()
  const [paste, setPaste] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragged, setDragged] = useState<number>()
  const [dropAt, setDropAt] = useState<number>()
  const update = (index: number, patch: Partial<(typeof rows)[number]>) => setRows(current => current.map((row, at) => at === index ? { ...row, ...patch } : row))
  const move = (from: number, to: number) => {
    const next = [...rows]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved!); setRows(next)
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <div className={css.editor}>
    <label>{t('importText')}<textarea disabled={busy} value={paste} onChange={event => setPaste(event.target.value)} /></label>
    <div className={css.actions}>{([false, true] as const).map(table => <Button key={String(table)} variant="outline" disabled={busy}
      onClick={() => void run(async () => { setRows([...rows, ...(await props.importPresets(paste, table)).map(row => ({ ...row, id: crypto.randomUUID(), expanded: false }))]) })}>
      {t(table ? 'importTable' : 'batchPaste')}</Button>)}</div>
    {split && <div className={css.actions} role="status">
      {t('splitPresets').replace('{count}', String(split.count))}
      <Button size="sm" disabled={busy} onClick={() => { setRows(split.before); setSplit(undefined) }}>{t('undoSplit')}</Button>
    </div>}
    {rows.map((row, index) => <fieldset key={row.id} className={css.row} disabled={busy}
      data-drop={dropAt === index ? 'before' : dropAt === rows.length && index === rows.length - 1 ? 'after' : undefined}
      onDragOver={event => {
        event.preventDefault()
        if (dragged !== undefined) {
          event.dataTransfer.dropEffect = 'move'
          const bounds = event.currentTarget.firstElementChild!.getBoundingClientRect()
          setDropAt(index + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0))
        }
      }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(undefined) }}
      onDrop={event => {
        event.preventDefault(); event.stopPropagation()
        if (event.dataTransfer.files.length) {
          update(index, { directories: [...new Set([...row.directories, ...props.droppedPaths(Array.from(event.dataTransfer.files))])] })
        } else if (dragged !== undefined && dropAt !== undefined) {
          move(dragged, dropAt > dragged ? dropAt - 1 : dropAt)
        }
        setDragged(undefined); setDropAt(undefined)
      }}>
      <div className={css.summary}>
        <Button size="sm" className={css.handle} draggable={!busy} aria-label={t('dragPreset')}
          onDragStart={event => {
            setDragged(index)
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', row.id)
            event.dataTransfer.setDragImage(event.currentTarget.parentElement!, 12, 12)
          }} onDragEnd={() => { setDragged(undefined); setDropAt(undefined) }}>⠿</Button>
        <span className={css.summaryText} data-invalid={!row.name.trim() || !row.prompt.trim()} title={row.name}>{row.name || t('addPreset')}</span>
        <span className={css.summaryText} data-invalid={!row.directories.some(path => path.trim())} title={row.directories[0]}>{row.directories[0] || t('presetDirectories')}</span>
        <Button size="sm" disabled={index === 0} onClick={() => move(index, index - 1)}>{t('movePresetUp')}</Button>
        <Button size="sm" disabled={index === rows.length - 1} onClick={() => move(index, index + 1)}>{t('movePresetDown')}</Button>
        <Button size="sm" aria-expanded={row.expanded} onClick={() => update(index, { expanded: !row.expanded })}>{t(row.expanded ? 'collapsePreset' : 'expandPreset')}</Button>
      </div>
      {row.expanded && <>
        <label>{t('presetPrompt')}<textarea value={row.prompt} aria-invalid={!row.prompt.trim()} onPaste={event => {
          const text = event.clipboardData.getData('text/plain')
          if (importPresets(text, false).length < 2) return
          event.preventDefault()
          void run(async () => {
            const imported = await props.importPresets(text, false)
            const replacements = imported.map((preset, at) => ({ ...row, ...preset,
              directories: preset.directories.length ? preset.directories : [...row.directories],
              id: at === 0 ? row.id : crypto.randomUUID(), expanded: at === 0 }))
            setSplit({ before: rows, count: replacements.length })
            setRows([...rows.slice(0, index), ...replacements, ...rows.slice(index + 1)])
          })
        }} onChange={event => {
          const prompt = event.target.value
          update(index, { prompt, ...(row.name === '' || row.name === props.namePreset(row.prompt) ? { name: props.namePreset(prompt) } : {}) })
        }} /></label>
        <label>{t('presetName')}<input value={row.name} aria-invalid={!row.name.trim()} onChange={event => update(index, { name: presetName(event.target.value) })} /></label>
        <label>{t('presetDirectories')}<textarea value={row.directories.join('\n')} placeholder={t('dropDirectories')} aria-invalid={!row.directories.some(path => path.trim())}
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
      </>}
    </fieldset>)}
    <p>{t('reorderPresets')}</p>
    <Button variant="outline" disabled={busy} onClick={() => setRows([...rows.map(row => ({ ...row, expanded: false })), { name: '', prompt: '', directories: [], id: crypto.randomUUID(), expanded: true }])}>{t('addPreset')}</Button>
    <Button variant="primary" disabled={busy || rows.some(row => !row.name.trim() || !row.prompt.trim() || !row.directories.some(path => path.trim()))}
      onClick={() => void run(async () => {
        const saved = rows.map(row => ({ name: presetName(row.name), prompt: row.prompt,
          directories: row.directories.map(path => path.trim()).filter(Boolean),
          ...(row.model?.trim() ? { model: row.model.trim() } : {}), ...(row.permission?.trim() ? { permission: row.permission.trim() } : {}) }))
        if (!await props.savePresets(saved, props.revision)) throw new Error(t('presetSaveFailed'))
        props.done(saved.length)
      })}>{t('save')}</Button>
    {error && <p role="alert">{error}</p>}
  </div>
}

/** Shared settings and quick-panel management controls. */
function Management(props: PresetsProps) {
  const form = props.usePresets(value => value)
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState<number>()
  return <>
    <Button variant="outline" disabled={form.status !== 'ready' || !form.writable} onClick={() => { setSaved(undefined); setEditing(true) }}>{props.t('editPresets')}</Button>
    <Modal className={css.modal!} open={editing} title={props.t('presetsTitle')} closeLabel={props.t('close')} onClose={() => setEditing(false)}>
      {editing && <Editor {...props} initial={form.value?.openingPresets ?? []} revision={form.revision} done={count => { setEditing(false); setSaved(count) }} />}
    </Modal>
    {saved !== undefined && <Toast tone="success" text={props.t('presetSaved').replace('{count}', String(saved))} onDone={() => setSaved(undefined)} />}
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
function Picker(props: PresetsProps & { currentDirectory: string | undefined; sessionId: SessionId | undefined; quick?: boolean }) {
  const presets = props.usePresets(state => state.value?.openingPresets ?? [])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [saved, setSaved] = useState<number>()
  const form = props.usePresets(state => state)
  const matches = (preset: OpeningPreset) => props.currentDirectory !== undefined && preset.directories.includes(props.currentDirectory)
  const item = (preset: OpeningPreset, index: number) => ({ id: String(index), label: preset.name,
    ...(!matches(preset) && preset.directories.length > 1 ? { submenu: preset.directories.map((directory, at) => ({ id: `${index}:${at}`, label: directory })) } : {}) })
  const items: MenuEntry[] = presets.flatMap((preset, index) => matches(preset) ? [item(preset, index)] : [])
  const directories = [...new Set(presets.filter(preset => !matches(preset)).map(preset => preset.directories[0]!))]
  for (const directory of directories) {
    items.push({ type: 'label', id: `directory:${directory}`, text: directory })
    presets.forEach((preset, index) => { if (!matches(preset) && preset.directories[0] === directory) items.push(item(preset, index)) })
  }
  items.push({ type: 'separator', id: 'manage-separator' })
  if (props.quick) items.push({ id: 'add', label: props.t('addPreset'), disabled: form.status !== 'ready' || !form.writable })
  items.push({ id: 'manage', label: props.t('managePresets') })
  return <>
    <Menu open={open} onClose={() => setOpen(false)} items={items} portal autoFocus align={props.quick ? 'end' : 'start'}
      anchor={<Button variant="outline" size="sm" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{props.t(props.quick ? 'presetsTitle' : 'opening')}</Button>}
      onSelect={id => {
        setOpen(false)
        if (id === 'add') { setSaved(undefined); setAdding(true); return }
        if (id === 'manage') { props.managePresets(); return }
        const [index, at] = id.split(':').map(Number)
        const preset = presets[index!]!
        const directory = at === undefined && matches(preset) ? props.currentDirectory! : preset.directories[at ?? 0]!
        setBusy(true); setError('')
        void props.choosePreset(index!, directory, directory === props.currentDirectory ? props.sessionId : undefined).catch(reason => setError(String(reason))).finally(() => setBusy(false))
      }} />
    <Modal className={css.modal!} open={adding} title={props.t('addPreset')} closeLabel={props.t('close')} onClose={() => setAdding(false)}>
      {adding && <Editor {...props} expandFirst initial={[{ name: '', prompt: '', directories: [] }, ...(form.value?.openingPresets ?? [])]}
        revision={form.revision} done={count => { setAdding(false); setSaved(count) }} />}
    </Modal>
    {saved !== undefined && <Toast tone="success" text={props.t('presetSaved').replace('{count}', String(saved))} onDone={() => setSaved(undefined)} />}
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
  return <Picker {...props} quick />
}
