/** Session-free skill discovery, scan directories, and global provider controls. */
import { useState } from 'react'
import { Button } from '@panedesk/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { WorkspaceId, WorkspaceSnapshot } from '@panedesk/dsh-api-workspace-controller/client'
import type { ObservableSnapshot } from '@panedesk/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { SkillPageGroup, SkillPageListing, SkillPageOperations } from './catalog.ts'
import type { en } from './locales.ts'
import styles from './SkillsSection.module.css'

/** Copy keys this section renders. */
type Copy = (key: keyof typeof en) => string

/** Host reads, writes, and copy bound by the renderer. */
export interface SkillsSectionInjected {
  readonly hooks: { readonly directories: ObservableSnapshot<WorkspaceSnapshot> }
  readonly operations: SkillPageOperations
  readonly t: Copy
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | Extract<SkillPageListing, { kind: 'listed' }>
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'unavailable' | 'disabled' | 'denied' }

const GROUPS: readonly SkillPageGroup[] = ['builtin', 'user', 'project']

/**
 * Render scan roots and their effective skills for the selected workspace.
 * @param props - host operations, workspace source, and copy.
 * @returns the settings section.
 */
export function SkillsSection(props: Pick<PropsRuntime<'settings.section'>, 'close'> & InjectFace<SkillsSectionInjected>): ReactNode {
  const { operations, t, useDirectories } = props
  const workspaces = useDirectories(snapshot => snapshot.items)
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId>()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [notice, setNotice] = useState<string>()
  const [saving, setSaving] = useState(false)

  const load = async (selected: WorkspaceId | undefined): Promise<void> => {
    setPhase({ kind: 'loading' })
    setNotice(undefined)
    try {
      const answer = await operations.list(selected)
      if (answer.kind === 'listed') setPhase(answer)
      else if (answer.reason === 'failed') setPhase({ kind: 'failed', message: answer.message ?? t('loadFailed') })
      else setPhase({ kind: answer.reason })
    } catch (error: unknown) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const open = async (path: string, action: 'open' | 'reveal' = 'open'): Promise<void> => {
    try {
      const failure = await operations.open(path, action)
      setNotice(failure === undefined ? t('opened') : `${t('openFailed')}: ${failure}`)
    } catch (error: unknown) {
      setNotice(`${t('openFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const save = async (ns: string, patch: Parameters<SkillPageOperations['configure']>[1]): Promise<void> => {
    setSaving(true)
    try {
      const failure = await operations.configure(ns, patch)
      if (failure !== undefined) setNotice(`${t('saveFailed')}: ${failure}`)
      else {
        await load(workspaceId)
        setNotice(t('saved'))
      }
    } catch (error: unknown) {
      setNotice(`${t('saveFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const groupLabel = (group: SkillPageGroup): string => {
    if (group === 'builtin') return t('groupBuiltin')
    if (group === 'user') return t('groupUser')
    return t('groupProject')
  }

  return (
    <section className={styles['section']}>
      <h2>{t('title')}</h2>
      <p>{t('intro')}</p>
      <p>{t('scope')}</p>
      <label>
        {t('workspace')}
        <select value={workspaceId ?? ''} disabled={phase.kind === 'loading' || saving} onChange={(event) => {
          const selected = workspaces.find(workspace => workspace.workspaceId === event.target.value)?.workspaceId
          setWorkspaceId(selected)
          void load(selected)
        }}>
          <option value="">{t('hostSkills')}</option>
          {workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>)}
        </select>
      </label>
      <Button variant="outline" type="button" disabled={phase.kind === 'loading' || saving} onClick={() => { void load(workspaceId) }}>{t('load')}</Button>
      {phase.kind === 'loading' ? <p role="status">{t('loading')}</p> : null}
      {phase.kind === 'unavailable' ? <p role="status">{t('unavailable')}</p> : null}
      {phase.kind === 'disabled' ? <p role="status">{t('disabled')}</p> : null}
      {phase.kind === 'denied' ? <p role="alert">{t('denied')}</p> : null}
      {phase.kind === 'failed' ? <p role="alert">{t('loadFailed')}: {phase.message}</p> : null}
      {phase.kind === 'listed' ? (
        <div>
          {phase.workspace ? null : <p>{t('noWorkspace')}</p>}
          <h3>{t('configuration')}</h3>
          <p>{t('defaults')}</p>
          {phase.settings.length === 0 ? <p>{t('notConfigurable')}</p> : null}
          {phase.settings.map(setting => (
            <fieldset key={setting.ns} disabled={saving}>
              <legend>{setting.ns}</legend>
              <p>{t('globalControls')}</p>
              <p>{t('configPath')}: <span>{setting.path}</span></p>
              <Button variant="outline" type="button" onClick={() => { void open(setting.path) }}>{t('openConfig')}</Button>
              <Button variant="outline" type="button" onClick={() => { void open(setting.path, 'reveal') }}>{t('reveal')}</Button>
              <label>
                <input type="checkbox" checked={setting.value.enabled} onChange={(event) => { void save(setting.ns, { enabled: event.target.checked }) }} />
                {t('enabled')}
              </label>
              <label>
                <input type="checkbox" checked={setting.value.includeDefaultRoots} onChange={(event) => { void save(setting.ns, { includeDefaultRoots: event.target.checked }) }} />
                {t('defaultRoots')}
              </label>
              <label>
                <input type="checkbox" checked={setting.value.watch} onChange={(event) => { void save(setting.ns, { watch: event.target.checked }) }} />
                {t('watch')}
              </label>
              <label>
                {t('pollInterval')}
                <input type="number" min="1" step="1" defaultValue={setting.value.watchPollIntervalMs} onBlur={(event) => {
                  if (event.target.validity.valid && event.target.value !== '' && event.target.valueAsNumber !== setting.value.watchPollIntervalMs) {
                    void save(setting.ns, { watchPollIntervalMs: event.target.valueAsNumber })
                  }
                }} />
              </label>
              <label>
                {t('customRoots')}
                <textarea defaultValue={setting.value.customSkillDirs.join('\n')} onBlur={(event) => {
                  const paths = event.target.value.split('\n').map(path => path.trim()).filter(Boolean)
                  if (JSON.stringify(paths) !== JSON.stringify(setting.value.customSkillDirs)) void save(setting.ns, { customSkillDirs: paths })
                }} />
              </label>
            </fieldset>
          ))}
          <h3>{t('scanDirectories')}</h3>
          <p>{t('countHelp')}</p>
          <ul>
            {phase.directories.map((directory, index) => (
              <li key={`${index}:${directory.provider}:${directory.source}:${directory.path}`}>
                <strong>{directory.source}</strong> <span>{directory.provider}</span>
                <p className={styles['path']}>{directory.path}</p>
                <p>{directory.exists ? t('exists') : t('missing')} · {t('skillCount')}: {directory.count}</p>
                <Button variant="outline" type="button" disabled={!directory.exists} onClick={() => { void open(directory.path) }}>{t('openDirectory')}</Button>
              </li>
            ))}
          </ul>
          {GROUPS.map(group => {
            const rows = phase.entries.filter(entry => entry.group === group)
            return (
              <div key={group}>
                <h3>{groupLabel(group)}</h3>
                {rows.length === 0 ? <p>{t('empty')}</p> : (
                  <ul>
                    {rows.map(entry => (
                      <li key={entry.path}>
                        <strong>{entry.name}</strong>
                        <p>{entry.description}</p>
                        <p className={styles['path']}>{t('sourcePath')}: {entry.path}</p>
                        <Button variant="outline" type="button" onClick={() => { void open(entry.path) }}>{t('open')}</Button>
                        <Button variant="outline" type="button" onClick={() => { void open(entry.path, 'reveal') }}>{t('reveal')}</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      ) : null}
      {notice === undefined ? null : <p role="status">{notice}</p>}
    </section>
  )
}
