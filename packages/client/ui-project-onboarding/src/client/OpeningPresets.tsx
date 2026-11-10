/** Product-owned preset editing and selection without automatic submission. */
import { Fragment, useRef, useState } from 'react'
import { Button, IconTrashOutlineRegular, Menu, Modal, SettingsPageHeader } from '@panedesk/dsh-client-ui-primitives'
import type { MenuEntry } from '@panedesk/dsh-client-ui-primitives'
import type { OpeningPreset } from '../types.ts'
import { presetName } from '../preset-name.ts'
import { importPresets } from './preset-import.ts'
import type { PresetChoices, PresetsProps, PresetSettingsProps, PresetPickerProps, PresetQuickProps } from './preset-props.ts'
import { PresetSelect } from './PresetSelect.tsx'
import css from './OpeningPresets.module.css'

/** Editable local rows are persisted atomically through the shared product form. */
function Editor(props: PresetsProps & { initial: OpeningPreset[]; choices: PresetChoices; revision: number | undefined; currentDirectory: string | undefined }) {
  const { t } = props
  const writable = props.usePresets(form => form.status === 'ready' && form.writable)
  const [rows, setRows] = useState(() => props.initial.map(row => ({ ...row, directories: row.directories.slice(0, 1), id: crypto.randomUUID(), expanded: false })))
  const [added, setAdded] = useState<{ id: string; count: number }>()
  const scrolled = useRef<string | undefined>(undefined)
  const models = props.choices.models.flatMap(group => group.models.map(model => ({ ...model, provider: group.id,
    key: `${group.id}/${model.id}`, label: `${group.name} / ${model.name}` })))
  const uniqueModels = models.filter((model, index) => models.findIndex(other => other.key === model.key) === index)
  const modelOptions = [{ id: '', label: t('followCurrent') }, ...uniqueModels.map(model => ({ id: model.key,
    label: uniqueModels.some(other => other !== model && other.provider === model.provider && other.name === model.name)
      ? `${model.label} (${model.id})` : model.label }))]
  const [split, setSplit] = useState<{ before: typeof rows; count: number }>()
  const [paste, setPaste] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<number>()
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
    <div className={css.actions}>{([false, true] as const).map(table => <Fragment key={String(table)}><Button variant="outline" disabled={busy}
      onClick={() => void run(async () => {
        const imported = (await props.importPresets(paste, table)).map(row => ({ ...row,
          directories: (row.directories.length ? row.directories : !table && props.currentDirectory ? [props.currentDirectory] : []).slice(0, 1),
          id: crypto.randomUUID(), expanded: false }))
        setRows([...rows, ...imported])
        setAdded(imported.length ? { id: imported[0]!.id, count: imported.length } : undefined)
      })}>
      {t(table ? 'importTable' : 'batchPaste')}</Button>
      {!table && added && <span key={added.id} className={css.saved} role="status" onAnimationEnd={() => setAdded(undefined)}>{t('presetsAdded').replace('{count}', String(added.count))}</span>}
    </Fragment>)}</div>
    {split && <div className={css.actions} role="status">
      {t('splitPresets').replace('{count}', String(split.count))}
      <Button size="sm" disabled={busy} onClick={() => { setRows(split.before); setSplit(undefined) }}>{t('undoSplit')}</Button>
    </div>}
    {rows.length === 0 && <p>{t('noPresets')}</p>}
    {rows.map((row, index) => {
      const selected = models.find(model => [model.key, model.id, model.name].some(key => row.model === key || row.model?.startsWith(key + ' / ') || row.model?.startsWith(key + ' ')))
      const modelKey = selected && [selected.key, selected.id, selected.name].find(key => row.model === key || row.model?.startsWith(key + ' / ') || row.model?.startsWith(key + ' '))
      const effort = modelKey ? row.model!.slice(modelKey.length).replace(/^\s*\/\s*/u, '').trim() : ''
      return <fieldset key={row.id} className={css.row} disabled={busy}
      ref={element => {
        if (element && added?.id === row.id && scrolled.current !== row.id) {
          scrolled.current = row.id
          element.scrollIntoView({ block: 'nearest' })
        }
      }}
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
          const paths = props.droppedPaths(Array.from(event.dataTransfer.files))
          if (paths.length) update(index, { directories: paths.slice(0, 1) })
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
            event.dataTransfer.setDragImage(event.currentTarget.nextElementSibling!, 12, 6)
          }} onDragEnd={() => { setDragged(undefined); setDropAt(undefined) }}>⠿</Button>
        <span className={css.dragPreview} aria-hidden="true" />
        <span className={css.summaryText} data-invalid={!row.name.trim() || !row.prompt.trim()} title={row.name}>{row.name || t('addPreset')}</span>
        <span className={css.summaryText} data-invalid={!row.directories.some(path => path.trim())} title={row.directories[0]}>{row.directories[0] || t('presetDirectories')}</span>
        <Button size="sm" disabled={index === 0} onClick={() => move(index, index - 1)}>{t('movePresetUp')}</Button>
        <Button size="sm" disabled={index === rows.length - 1} onClick={() => move(index, index + 1)}>{t('movePresetDown')}</Button>
        <Button size="sm" aria-expanded={row.expanded} onClick={() => update(index, { expanded: !row.expanded })}>{t(row.expanded ? 'collapsePreset' : 'expandPreset')}</Button>
        <Button size="sm" aria-label={t('deletePreset')} icon={<IconTrashOutlineRegular />} onClick={() => setRows(rows.filter((_, at) => at !== index))} />
      </div>
      {row.expanded && <>
        <label>{t('presetPrompt')}<textarea value={row.prompt} aria-invalid={!row.prompt.trim()} onPaste={event => {
          const text = event.clipboardData.getData('text/plain')
          if (importPresets(text, false).length < 2) return
          event.preventDefault()
          void run(async () => {
            const imported = await props.importPresets(text, false)
            const replacements = imported.map((preset, at) => ({ ...row, ...preset,
              directories: (preset.directories.length ? preset.directories : row.directories).slice(0, 1),
              id: at === 0 ? row.id : crypto.randomUUID(), expanded: at === 0 }))
            const before = rows.map((previous, at) => at === index ? { ...previous, prompt: text, name: props.namePreset(text),
              directories: previous.directories.length ? previous.directories : replacements[0]!.directories } : previous)
            setSplit({ before, count: replacements.length })
            setRows([...rows.slice(0, index), ...replacements, ...rows.slice(index + 1)])
          })
        }} onChange={event => {
          const prompt = event.target.value
          update(index, { prompt, ...(row.name === '' || row.name === props.namePreset(row.prompt) ? { name: props.namePreset(prompt) } : {}) })
        }} onBlur={() => {
          if (!row.directories.length && row.prompt.trim()) void props.inferDirectory(row.prompt).then(directory => {
            if (directory) setRows(current => current.map(item => item.id === row.id && !item.directories.length ? { ...item, directories: [directory] } : item))
          }).catch(reason => setError(String(reason)))
        }} /></label>
        <label>{t('presetName')}<input value={row.name} aria-invalid={!row.name.trim()} onChange={event => update(index, { name: presetName(event.target.value) })} /></label>
        <div className={css.folder}>
          <span className={css.folderPath} title={row.directories[0]} aria-label={t('presetDirectories')} aria-invalid={!row.directories.length}>
            {row.directories[0] || t('dropDirectory')}
          </span>
          <Button variant="outline" onClick={() => void run(async () => {
            const directory = await props.pickDirectory()
            if (directory) update(index, { directories: [directory] })
          })}>{t('changeDirectory')}</Button>
        </div>
        <div className={css.actions}>
          <div className={css.choice}><span>{t('presetModel')}</span>
            <PresetSelect label={t('presetModel')} value={selected?.key ?? row.model ?? ''} options={modelOptions} disabled={busy}
              onSelect={model => update(index, { model })} />
          </div>
          {selected && selected.reasoning && selected.reasoning.efforts.length > 0 && <div className={css.choice}><span>{t('presetEffort')}</span>
            <PresetSelect label={t('presetEffort')} value={effort} disabled={busy}
              options={[{ id: '', label: t('defaultEffort') }, ...selected.reasoning.efforts.map(item => ({ id: item.id, label: item.name }))]}
              onSelect={value => update(index, { model: selected.key + (value ? ` / ${value}` : '') })} />
          </div>}
          <div className={css.choice}><span>{t('presetPermission')}</span>
            <PresetSelect label={t('presetPermission')} value={row.permission ?? ''} disabled={busy}
              options={[{ id: '', label: t('followCurrent') }, ...props.choices.permissions]}
              onSelect={permission => update(index, { permission })} />
          </div>
        </div>
      </>}
    </fieldset>})}
    <p>{t('reorderPresets')}</p>
    <Button variant="outline" disabled={busy} onClick={() => setRows([...rows.map(row => ({ ...row, expanded: false })), { name: '', prompt: '', directories: [], id: crypto.randomUUID(), expanded: true }])}>{t('addPreset')}</Button>
    <div className={css.actions}>
      <Button variant="primary" disabled={busy || !writable || rows.some(row => !row.name.trim() || !row.prompt.trim() || !row.directories.some(path => path.trim()))}
        onClick={() => { setSaved(undefined); void run(async () => {
          const saved = rows.map(row => ({ name: presetName(row.name), prompt: row.prompt,
            directories: row.directories.slice(0, 1).map(path => path.trim()).filter(Boolean),
            ...(row.model?.trim() ? { model: row.model.trim() } : {}), ...(row.permission?.trim() ? { permission: row.permission.trim() } : {}) }))
          if (!await props.savePresets(saved, props.revision)) throw new Error(t('presetSaveFailed'))
          setSplit(undefined)
          setSaved(saved.length)
        }) }}>{t('save')}</Button>
      {saved !== undefined && <span className={css.saved} role="status" onAnimationEnd={() => setSaved(undefined)}>{t('presetSaved').replace('{count}', String(saved))}</span>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>
}

/** Settings and quick access use the same editor initialization, including an empty list. */
function PresetEditor(props: PresetsProps & Pick<PresetSettingsProps, 'useSessions' | 'useWorkspaces'> & { choices: PresetChoices | undefined; close: () => void; currentDirectory?: string | undefined }) {
  const form = props.usePresets(value => value)
  const presets = form.value?.openingPresets ?? []
  const sessionId = props.useSessions(value => Object.values(value.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  const directory = props.useWorkspaces(value => value.items.find(item => sessionId !== undefined && item.sessionIds.includes(sessionId))?.path)
  return <Modal className={css.modal!} open={props.choices !== undefined} title={props.t('presetsTitle')} closeLabel={props.t('close')} onClose={props.close} closeOnMaskClick={false}>
    {props.choices && <Editor {...props} choices={props.choices} initial={presets} revision={form.revision} currentDirectory={props.currentDirectory ?? directory} />}
  </Modal>
}

/** Shared settings and quick-panel management controls. */
function Management(props: PresetSettingsProps) {
  const [choices, setChoices] = useState<PresetChoices>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <>
    <div className={css.actions}><Button variant="outline" disabled={busy} onClick={() => {
      setBusy(true); setError('')
      void props.loadChoices().then(setChoices).catch(reason => setError(String(reason))).finally(() => setBusy(false))
    }}>{props.t('editPresets')}</Button></div>
    <PresetEditor {...props} choices={choices} close={() => setChoices(undefined)} />
    {error && <p role="alert">{error}</p>}
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
function Picker(props: PresetPickerProps & { quick?: boolean }) {
  const presets = props.usePresets(state => state.value?.openingPresets ?? [])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [choices, setChoices] = useState<PresetChoices>()
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
        if (id === 'add') {
          setBusy(true); setError('')
          void props.loadChoices().then(setChoices).catch(reason => setError(String(reason))).finally(() => setBusy(false))
          return
        }
        if (id === 'manage') { props.managePresets(); return }
        const [index, at] = id.split(':').map(Number)
        const preset = presets[index!]!
        const directory = at === undefined && matches(preset) ? props.currentDirectory! : preset.directories[at ?? 0]!
        setBusy(true); setError('')
        void props.choosePreset(index!, directory, directory === props.currentDirectory ? props.sessionId : undefined).catch(reason => setError(String(reason))).finally(() => setBusy(false))
      }} />
    <PresetEditor {...props} choices={choices} close={() => setChoices(undefined)} />
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
