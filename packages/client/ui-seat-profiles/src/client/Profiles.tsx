/** Profile settings with staged edits, impact confirmation and mapped table previews. */
import { useEffect, useState } from 'react'
import { IconPanedeskSeatProfile } from '@panedesk/dsh-client-ui-panedesk-icons'
import { Button, Checkbox, Input, Menu, Modal } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@panedesk/dsh-client-ui-slots'
import type * as T from '@panedesk/dsh-seat/types'
import type { SeatProfileSnapshot } from '../types.ts'
import type { createProfileStore } from './store.ts'
import { rejectionCopy, type ProfileKey } from './locales.ts'
import css from './Profiles.module.css'

/** Product-owned mappings remain outside the generic importer. */
export interface ImportPreset { id: string; label: string; columnMap: Readonly<Record<string, string>> }
/** Plain editor interactions over the existing CAS and preview/commit operations. */
export interface ProfileActions {
  takeover(revision: number): Promise<void>
  save(definition: unknown, revision: number): Promise<number>
  remove(snapshot: SeatProfileSnapshot, seat: T.SeatName): Promise<void>
  preview(request: { format: 'csv' | 'markdown'; sourcePath: string; mapping: string; defaults: string; table: string }): Promise<T.SeatImportPlan>
  commit(plan: T.SeatImportPlan, selectedRows: readonly number[]): Promise<void>
  refresh(this: void): void
  presets: readonly ImportPreset[]
}
/** Settings component props derived from the declared shares. */
export type ProfilesProps = PropsRuntime<'settings.section'> & PropsLocale<'seatProfiles'> &
  PropsStore<ReturnType<typeof createProfileStore>> & InjectFace<ProfileActions>

type Copy = Pick<ProfilesProps, 't'>
const primary = ['directories', 'memoryDirectories', 'opening', 'openingInstructionFiles', 'agentPreset', 'provider', 'model',
  'reasoningEffort', 'permissionPreset', 'platform', 'node'] as const
const advanced = ['rules', 'projectId', 'subscriptions', 'checkpointFiles', 'remoteAdmission', 'wakeTemplate', 'autoKeepAlive',
  'maxOpenSessions', 'maxActiveSubagents', 'contextThresholdTokens', 'subagentContextThresholdTokens', 'pollingThreshold', 'maxSleepSeconds', 'worktree'] as const
const jsonFields = new Set<string>(['directories', 'memoryDirectories', 'opening', 'openingInstructionFiles', 'rules', 'subscriptions',
  'checkpointFiles', 'remoteAdmission', 'wakeTemplate', 'worktree', 'autoKeepAlive'])
const numberFields = new Set<string>(['maxOpenSessions', 'maxActiveSubagents', 'contextThresholdTokens', 'subagentContextThresholdTokens', 'pollingThreshold', 'maxSleepSeconds'])
function message(error: unknown, t: ProfilesProps['t']): string {
  if (error instanceof SyntaxError) return t('invalid')
  if (error instanceof Error && error.name === 'SeatWriteRejected') {
    const copy = rejectionCopy(error.message)
    return copy === undefined ? t('rejectUnknown', { code: error.message }) : t(copy)
  }
  return t(error instanceof Error && error.message === 'revision-conflict' ? 'conflict'
    : error instanceof Error && error.message === 'invalid-definition' ? 'invalid' : 'failed')
}
function unknownWrite(error: unknown): boolean {
  return !(error instanceof SyntaxError || error instanceof Error && (error.name === 'SeatWriteRejected'
    || ['revision-conflict', 'invalid-definition'].includes(error.message)))
}
function Editor({ definition, snapshot, save, remove, blocked, onUnknown, t }: Copy & Pick<ProfileActions, 'save' | 'remove'> & {
  onUnknown(this: void): void
  definition: T.SeatDefinition
  snapshot: SeatProfileSnapshot
  blocked: boolean
}) {
  const [base, setBase] = useState({ snapshot, definitionRevision: definition.revision, definition })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState(false)
  const windows = base.snapshot.windows.filter(item => item.seat === definition.seat)
  const pending = base.snapshot.pending.filter(item => item.seat === definition.seat)
  const field = (key: typeof primary[number] | typeof advanced[number]) => {
    const original = base.definition[key]
    const value = draft[key] ?? (original === undefined ? '' : typeof original === 'string' ? original : JSON.stringify(original, null, 2))
    const change = (value: string): void => { setDraft({ ...draft, [key]: value }); setNotice('') }
    return <label key={key}>{t(key)}{jsonFields.has(key)
      ? <textarea aria-label={t(key)} value={value} disabled={busy} onChange={(event) => { change(event.target.value) }} />
      : <Input aria-label={t(key)} value={value} disabled={busy} onChange={(event) => { change(event.target.value) }} />}</label>
  }
  const run = async (action: () => Promise<void>, success: ProfileKey): Promise<void> => {
    setBusy(true); setNotice('')
    try { await action(); setNotice(t(success)); setConfirm(false) }
    catch (error) { if (unknownWrite(error)) { setNotice(''); onUnknown() } else setNotice(message(error, t)) }
    finally { setBusy(false) }
  }
  const submit = async (): Promise<void> => {
    let edited: Record<string, unknown> = { ...base.definition, revision: base.definitionRevision + 1 }
    for (const [key, text] of Object.entries(draft)) {
      if (!text && ['remoteAdmission', 'wakeTemplate', 'contextThresholdTokens', 'pollingThreshold', 'maxSleepSeconds'].includes(key)) {
        edited = Object.fromEntries(Object.entries(edited).filter(([field]) => field !== key))
      }
      else if (jsonFields.has(key)) { const value: unknown = JSON.parse(text); edited[key] = value }
      else edited[key] = numberFields.has(key) ? Number(text) : text
    }
    const revision = await save(edited, base.snapshot.revision)
    setBase({ ...base, snapshot: { ...base.snapshot, revision }, definitionRevision: base.definitionRevision + 1 })
  }
  return <div className={css.form}>
    <h2>{definition.seat}</h2><p>{t('immutable')}</p>
    {primary.map(field)}
    <details><summary>{t('advanced')}</summary>{advanced.map(field)}</details>
    <div className={css.actions}><Button disabled={busy || deleted || blocked} onClick={() => { void run(submit, 'saved') }}>{t(busy ? 'saving' : 'save')}</Button>
      <Button disabled={busy || deleted || blocked} onClick={() => { setConfirm(true) }}>{t('remove')}</Button></div>
    {notice && <p role="status">{notice}</p>}
    <Modal open={confirm} title={t('removeTitle')} closeLabel={t('cancel')} onClose={() => { if (!busy) setConfirm(false) }}
      footer={<><Button disabled={busy} onClick={() => { setConfirm(false) }}>{t('cancel')}</Button>
        <Button disabled={busy || blocked} onClick={() => { if (!blocked) void run(async () => { await remove(base.snapshot, definition.seat); setDeleted(true) }, 'removed') }}>{t('confirmRemove')}</Button></>}>
      <p>{t('removeWarning')}</p><h3>{t('windows')}</h3>
      {windows.length === 0 ? <p>{t('none')}</p> : <ul>{windows.map(item => <li key={item.sessionId}><span>{item.title} — {item.sessionId}</span> <small>{item.stateKnown ? `${t('stateVersion')}: ${item.stateVersion}` : t('stateUnknown')}</small></li>)}</ul>}
      <h3>{t('pending')}</h3>{pending.length === 0 ? <p>{t('none')}</p>
        : <ul>{pending.map(item => <li key={item.queueItemId}><span>{item.queueItemId} — {item.reason}</span> <small>{t('stateVersion')}: {item.stateVersion}</small></li>)}</ul>}
    </Modal>
  </div>
}
function Importer({ preview, commit, presets, definition, onUnknown, t }: Copy & Pick<ProfileActions, 'preview' | 'commit' | 'presets'> & {
  definition: T.SeatDefinition | undefined
  onUnknown(this: void): void
}) {
  const [sourcePath, setSourcePath] = useState(''), [format, setFormat] = useState<'csv' | 'markdown'>('markdown')
  const [mapping, setMapping] = useState('{"seat":"seat"}'), [defaults, setDefaults] = useState('{}'), [table, setTable] = useState('')
  const [plan, setPlan] = useState<T.SeatImportPlan>(), [selected, setSelected] = useState<readonly number[]>([])
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [menu, setMenu] = useState(false)
  const changed = (): void => { setPlan(undefined); setSelected([]); setNotice('') }
  const run = async (action: () => Promise<void>, writing = false): Promise<void> => {
    setBusy(true); setNotice('')
    try { await action() } catch (error) {
      setPlan(undefined); setSelected([])
      if (writing && unknownWrite(error)) { setNotice(''); onUnknown() } else setNotice(message(error, t))
    }
    finally { setBusy(false) }
  }
  return <div className={css.form}><h2>{t('import')}</h2><p>{t('sourceChanged')}</p>
    <label>{t('sourcePath')}<Input aria-label={t('sourcePath')} disabled={busy} value={sourcePath} onChange={(event) => { setSourcePath(event.target.value); changed() }} /></label>
    <label>{t('format')}<select aria-label={t('format')} disabled={busy} value={format} onChange={(event) => { setFormat(event.target.value === 'csv' ? 'csv' : 'markdown'); changed() }}>
      <option value="markdown">{t('markdown')}</option><option value="csv">{t('csv')}</option></select></label>
    <label>{t('table')}<Input aria-label={t('table')} disabled={busy} value={table} onChange={(event) => { setTable(event.target.value); changed() }} /></label>
    {presets.length > 0 && <Menu open={menu} onClose={() => { setMenu(false) }}
      items={presets.map(item => ({ id: item.id, label: item.label }))}
      onSelect={(id) => {
        const preset = presets.find(item => item.id === id)
        if (preset) { setMapping(JSON.stringify(preset.columnMap, null, 2)); changed() }
        setMenu(false)
      }}
      anchor={<Button disabled={busy} onClick={() => { setMenu(!menu) }}>{t('preset')}</Button>} />}
    <label>{t('mapping')}<textarea aria-label={t('mapping')} disabled={busy} value={mapping} onChange={(event) => { setMapping(event.target.value); changed() }} /></label>
    <label>{t('defaults')}<textarea aria-label={t('defaults')} disabled={busy} value={defaults} onChange={(event) => { setDefaults(event.target.value); changed() }} /></label>
    <Button disabled={busy || !definition} onClick={() => { if (definition) { setDefaults(JSON.stringify(definition, null, 2)); changed() } }}>{t('useProfile')}</Button>
    <Button disabled={busy || !sourcePath.trim()} onClick={() => { void run(async () => {
      const next = await preview({ sourcePath, format, mapping, defaults, table }); setPlan(next); setSelected([])
    }) }}>{t(busy ? 'saving' : 'preview')}</Button>
    {plan && <><div>{plan.rows.length === 0 && <p>{t('noRows')}</p>}{plan.rows.map(row => <div key={row.row}>
      <Checkbox checked={selected.includes(row.row)} disabled={busy || row.action === 'invalid' || row.action === 'conflict' || row.action === 'retain'}
        label={t('row', { row: row.row, seat: row.seat ?? t('none'), action: row.action })}
        onChange={(checked) => { setSelected(checked ? [...selected, row.row] : selected.filter(value => value !== row.row)) }} />
      {row.diagnostics.map((item, index) => <p key={`${item.code}:${index}`}>{item.code}: {item.message} {item.alternative}</p>)}
      {row.differences.map(item => <p key={item.field}>{item.field}: {JSON.stringify(item.local)} → {JSON.stringify(item.source)}</p>)}
    </div>)}</div><Button disabled={busy || selected.length === 0} onClick={() => { void run(async () => {
      await commit(plan, selected); setPlan(undefined); setSelected([]); setNotice(t('imported'))
    }, true) }}>{t('commit')}</Button></>}
    {notice && <p role="status">{notice}</p>}
  </div>
}
/** Render profile selection and preserve an unsaved draft until its user explicitly reloads. */
export function Profiles(props: ProfilesProps) {
  const { t, useResource, actions, refresh } = props
  const resource = useResource<'seat-profiles'>('dsh-resource://seat-profiles/local')
  const seat = props.useStore(state => state.seat)
  const [editing, setEditing] = useState<{ snapshot: SeatProfileSnapshot; definition: T.SeatDefinition }>()
  const [importing, setImporting] = useState(false)
  const [reload, setReload] = useState(0)
  const [takeover, setTakeover] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [transferNotice, setTransferNotice] = useState('')
  const data = resource.value
  const [uncertain, setUncertain] = useState(false)
  const [refreshBase, setRefreshBase] = useState<SeatProfileSnapshot>()
  useEffect(() => {
    if (refreshBase && data && data !== refreshBase && resource.status === 'live') {
      setUncertain(false); setRefreshBase(undefined); setEditing(undefined); setReload(value => value + 1)
    }
  }, [data, refreshBase, resource.status])
  const onUnknown = (): void => { setRefreshBase(undefined); setUncertain(true) }
  if (!data) return resource.status === 'failed'
    ? <section><h2>{t('nav')}</h2><p role="alert">{t('unavailable')}</p><Button onClick={refresh}>{t('refresh')}</Button></section>
    : <p role="status">{t('loading')}</p>
  const blocked = resource.status !== 'live' || transferring || uncertain
  const definition = data.definitions.find(item => item.seat === seat)
  const current = editing?.definition.seat === seat ? editing : definition ? { snapshot: data, definition } : undefined
  const select = (definition: T.SeatDefinition): void => {
    setEditing({ snapshot: data, definition }); actions.select(definition.seat); setImporting(false)
  }
  return <section className={css.page}><h2><IconPanedeskSeatProfile />{t('nav')}</h2>
    <details><summary>{t('singleMachineAdvanced')}</summary>
    <div className={css.actions}><Button onClick={() => { actions.select(null); setEditing(undefined); setImporting(false) }}>{t('back')}</Button>
      <Button onClick={() => { setRefreshBase(data); refresh() }}>{t('refresh')}</Button>
      <Button onClick={() => { setImporting(!importing) }}>{t('import')}</Button></div>
    {data.authority === 'import-source' && <><p>{t('sourceOwned')}</p><Button disabled={blocked} onClick={() => { setTakeover(true) }}>{t('takeover')}</Button></>}
    {transferNotice && <p role="status">{transferNotice}</p>}
    {uncertain && <p role="status">{t('failed')}</p>}
    <Modal open={takeover} title={t('takeover')} closeLabel={t('cancel')} onClose={() => { if (!transferring) setTakeover(false) }}
      footer={<><Button disabled={transferring} onClick={() => { setTakeover(false) }}>{t('cancel')}</Button>
        <Button disabled={blocked} onClick={() => {
          if (blocked) return
          setTransferring(true)
          void props.takeover(data.revision).then(() => {
            setEditing(undefined); setReload(reload + 1); setTakeover(false); setTransferNotice(t('takenOver')); refresh()
          }, (error: unknown) => { setTransferNotice(message(error, t)) }).finally(() => { setTransferring(false) })
        }}>{t('confirmTakeover')}</Button></>}><p>{t('takeoverWarning')}</p></Modal>
    {resource.status === 'failed' && <p role="alert">{t('unavailable')}</p>}
    <fieldset disabled={blocked}>
      {importing ? <Importer {...props} definition={current?.definition} onUnknown={onUnknown} /> : current
        ? <Editor key={`${current.definition.seat}:${reload}`} {...props} {...current} blocked={blocked} onUnknown={onUnknown} />
        : data.definitions.length === 0 ? <p>{t('empty')}</p>
          : <ul>{data.definitions.map(item => <li key={item.seat}><Button onClick={() => { select(item) }}>{item.seat}</Button></li>)}</ul>}
    </fieldset>
    </details>
  </section>
}
