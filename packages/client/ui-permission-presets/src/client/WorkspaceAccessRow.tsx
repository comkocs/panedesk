/** Windows workspace grant inventory in General settings. */
import { useEffect } from 'react'
import { Button } from '@panedesk/dsh-client-ui-primitives'
import type { SnapshotStore } from '@panedesk/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { WorkspaceAccessState } from './workspace-access-store.ts'
import type { workspaceEn } from './locales.ts'
import css from './PermissionRow.module.css'

/** Registration-owned data and actions; the component has no service access. */
export interface WorkspaceAccessInjected {
  hooks: { workspaceGrants: SnapshotStore<WorkspaceAccessState> }
  load: () => Promise<void>
  selectDirectory: () => Promise<void>
  revoke: (workspace: string) => Promise<void>
}

/** Derived General-settings row props. */
export type WorkspaceAccessRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.workspaceAccess'> & InjectFace<WorkspaceAccessInjected>

/**
 * Render authorization origins and explicit owner actions.
 * @param props - Bound inventory and callbacks supplied at registration.
 * @returns The supported host's workspace list or its visible failure.
 */
export function WorkspaceAccessRow({ useWorkspaceGrants, load, selectDirectory, revoke, t }: WorkspaceAccessRowProps) {
  const state = useWorkspaceGrants(value => value)
  useEffect(() => { void load() }, [load])
  if (!state.supported && state.status === 'ready') return null
  const busy = state.status === 'loading' || state.status === 'saving'
  return <section>
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('title')}</div>
        <div className={css.desc}>{t('description')}</div>
        {state.error !== null && <div className={css.desc} role="alert">{t('failure')} {state.error}</div>}
      </div>
      <Button variant="ghost" disabled={busy} onClick={() => { void load() }}>{t('refresh')}</Button>
      <Button variant="outline" disabled={busy || !state.supported} onClick={() => { void selectDirectory() }}>{t('preauthorize')}</Button>
    </div>
    {busy && <div className={css.desc} role="status">{t('loading')}</div>}
    {state.status === 'ready' && state.entries.length === 0 && <div className={css.desc}>{t('empty')}</div>}
    {state.entries.map(entry => <div className={css.row} key={entry.workspace}>
      <div className={css.rowText}>
        <div className={css.title}>{entry.workspace}</div>
        <div className={css.desc}>{t(entry.source === 'revocation-pending' ? 'pending' : entry.source === 'legacy' ? 'legacy' : entry.source === 'first-confirmation' ? 'first' : 'settings')}</div>
        {entry.grantedAt !== undefined && <time className={css.desc} dateTime={entry.grantedAt}>{entry.grantedAt}</time>}
      </div>
      <Button variant="outline" disabled={busy} onClick={() => { void revoke(entry.workspace) }}>{t('revoke')}</Button>
    </div>)}
  </section>
}

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Native Windows workspace authorization settings. */
    'settings.workspaceAccess': keyof typeof workspaceEn
  }
}
