/**
 * Read-only Skills settings section. It lists built-in, user, and project
 * skills and opens a source file through the host. It does not edit skills.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkspaceId, WorkspaceSnapshot } from '@panedesk/dsh-api-workspace-controller/client'
import type { ObservableSnapshot } from '@panedesk/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { SkillPageEntry, SkillPageGroup, SkillPageOperations } from './catalog.ts'
import type { en } from './locales.ts'
import styles from './SkillsSection.module.css'

/** Copy keys this section renders. */
type Copy = (key: keyof typeof en) => string

/** What the section renders from. */
export interface SkillsSectionInjected {
  /** Registered workspace source bound by the renderer. */
  readonly hooks: { readonly directories: ObservableSnapshot<WorkspaceSnapshot> }
  /** Host reads. */
  readonly operations: SkillPageOperations
  /** Section copy. */
  readonly t: Copy
}

/** Page posture. */
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty'; readonly workspace: boolean }
  | { readonly kind: 'listed'; readonly entries: readonly SkillPageEntry[]; readonly workspace: boolean }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'denied' }

const GROUPS: readonly SkillPageGroup[] = ['builtin', 'user', 'project']

/**
 * Render the three skill directories.
 * @param props - host reads and copy.
 * @returns the section.
 */
export function SkillsSection(props: Pick<PropsRuntime<'settings.section'>, 'close'> & InjectFace<SkillsSectionInjected>): ReactNode {
  const { operations, t, useDirectories } = props
  const directories = useDirectories(snapshot => snapshot.items)
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId>()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = async (): Promise<void> => {
    setPhase({ kind: 'loading' })
    setNotice(undefined)
    let answer: Awaited<ReturnType<SkillPageOperations['list']>>
    try {
      answer = await operations.list(workspaceId)
    } catch (error: unknown) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
      return
    }
    if (answer.kind === 'refused') {
      if (answer.reason === 'unavailable') setPhase({ kind: 'unavailable' })
      else if (answer.reason === 'disabled') setPhase({ kind: 'disabled' })
      else if (answer.reason === 'denied') setPhase({ kind: 'denied' })
      else setPhase({ kind: 'failed', message: answer.message ?? t('loadFailed') })
      return
    }
    setPhase(answer.entries.length === 0
      ? { kind: 'empty', workspace: answer.workspace }
      : { kind: 'listed', entries: answer.entries, workspace: answer.workspace })
  }

  const open = async (path: string): Promise<void> => {
    try {
      const failure = await operations.open(path)
      setNotice(failure === undefined ? t('opened') : `${t('openFailed')}: ${failure}`)
    } catch (error: unknown) {
      setNotice(`${t('openFailed')}: ${error instanceof Error ? error.message : String(error)}`)
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
      <label>
        {t('workspace')}
        <select value={workspaceId ?? ''} disabled={phase.kind === 'loading'} onChange={(event) => {
          setWorkspaceId(directories.find(directory => directory.workspaceId === event.target.value)?.workspaceId)
          setPhase({ kind: 'idle' })
          setNotice(undefined)
        }}>
          <option value="">{t('hostSkills')}</option>
          {directories.map(directory => <option key={directory.workspaceId} value={directory.workspaceId}>{directory.title}</option>)}
        </select>
      </label>
      {phase.kind === 'idle'
        ? <button type="button" onClick={() => { void load() }}>{t('load')}</button>
        : null}
      {phase.kind === 'loading' ? <p role="status">{t('loading')}</p> : null}
      {phase.kind === 'unavailable' ? <p role="status">{t('unavailable')}</p> : null}
      {phase.kind === 'disabled' ? <p role="status">{t('disabled')}</p> : null}
      {phase.kind === 'denied' ? <p role="alert">{t('denied')}</p> : null}
      {phase.kind === 'failed'
        ? (
          <div>
            <p role="alert">{t('loadFailed')}: {phase.message}</p>
            <button type="button" onClick={() => { void load() }}>{t('retry')}</button>
          </div>
        )
        : null}
      {phase.kind === 'empty'
        ? (
          <div>
            {phase.workspace ? null : <p>{t('noWorkspace')}</p>}
            <p>{t('empty')}</p>
          </div>
        )
        : null}
      {phase.kind === 'listed'
        ? (
          <div>
            {phase.workspace ? null : <p>{t('noWorkspace')}</p>}
            {GROUPS.map((group) => {
              const rows = phase.entries.filter(entry => entry.group === group)
              return (
                <div key={group}>
                  <h3>{groupLabel(group)}</h3>
                  {rows.length === 0
                    ? <p>{t('empty')}</p>
                    : (
                      <ul>
                        {rows.map(entry => (
                          <li key={entry.path}>
                            <strong>{entry.name}</strong>
                            <p>{entry.description}</p>
                            <p>{t('sourcePath')}: <span>{entry.path}</span></p>
                            <button type="button" onClick={() => { void open(entry.path) }}>{t('open')}</button>
                          </li>
                        ))}
                      </ul>
                    )}
                </div>
              )
            })}
            {notice === undefined ? null : <p role="status">{notice}</p>}
          </div>
        )
        : null}
    </section>
  )
}
