/** Project-scoped opening controls with Host-owned configuration locations. */
import { useState } from 'react'
import { Button, Menu } from '@panedesk/dsh-client-ui-primitives'
import type { SettingsProps } from './props.ts'
import css from './ProjectGuide.module.css'

/** Render all known workspaces without entering a project Session.
 * @param props Framework workspace and preference hooks, inspection, and owner actions.
 * @returns Immediate-save opening modes, file actions, and an explicitly refreshable engine observation.
 */
export function ProjectSettings({ usePreferences, useWorkspaces, useInspection, retry, select, refresh, openPath, t }: SettingsProps) {
  const state = usePreferences(value => value)
  const workspaces = useWorkspaces(value => value)
  const inspection = useInspection(value => value)
  const [selected, setSelected] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pathFailure, setPathFailure] = useState(false)
  const [openingPath, setOpeningPath] = useState(false)
  const paths = [...new Set([...workspaces.items.map(item => item.path), ...Object.keys(state.projects)])]
  const path = selected !== null && paths.includes(selected) ? selected : paths[0]
  const mode = path === undefined ? 'remind' : state.projects[path]?.mode ?? 'remind'
  const files = inspection.value
  const catalogFile = files?.catalogFile
  const disabled = state.status !== 'ready' || !state.writable || path === undefined
  const open = async (file: string, action: 'open' | 'reveal') => {
    setOpeningPath(true)
    setPathFailure(false)
    try { setPathFailure(!await openPath(file, action)) }
    finally { setOpeningPath(false) }
  }
  return <div className={css.page}>
    <h2>{t('title')}</h2>
    <p>{t('settingsIntro')}</p>
    <section className={css.choice}>
      <h3>{t('scope')}</h3>
      <p>{t('scopeHint')}</p>
      <Menu open={menuOpen} portal autoFocus onClose={() => { setMenuOpen(false) }} selectedId={path}
        anchor={<Button variant="outline" disabled={paths.length === 0} aria-haspopup="menu" aria-expanded={menuOpen}
          aria-label={t('project')} onClick={() => { setMenuOpen(value => !value) }}>{path ?? t('chooseProject')}</Button>}
        items={paths.map(item => ({ id: item, label: workspaces.items.find(workspace => workspace.path === item)?.title || item }))}
        onSelect={value => { setSelected(value); setMenuOpen(false) }} />
      {path !== undefined && <p>{path}</p>}
      {workspaces.phase !== 'ready' && <p role="status">{t('workspacesLoading')}</p>}
      {workspaces.state === 'error' && <p role="alert">{t('workspacesError')}</p>}
      {paths.length === 0 && workspaces.phase === 'ready' && <p>{t('settingsEmpty')}</p>}
      <h3>{t('openingMode')}</h3>
      <p>{t('defaultMode')}</p>
      <div className={css.modes} role="group" aria-label={t('openingMode')}>
        {(['off', 'remind', 'auto'] as const).map(value => <div key={value}>
          <Button variant={mode === value ? 'primary' : 'outline'} aria-pressed={mode === value}
            disabled={disabled} onClick={() => { if (path !== undefined) void select(path, value) }}>{t(value)}</Button>
          <p>{t(`${value}Hint`)}</p>
        </div>)}
      </div>
      <p>{t('immediateSave')}</p>
      {state.status === 'loading' && <p role="status">{t('loading')}</p>}
      {state.status === 'saving' && <p role="status">{t('saving')}</p>}
      {state.status === 'ready' && !state.writable && <p role="status">{t('readonly')}</p>}
      {state.error && <div role="alert"><p>{t(state.compensation ? 'compensation' : 'error')}</p>
        {state.compensation && <ul>{state.compensation.map(outcome =>
          <li key={outcome.projectId}>{outcome.projectId}: {t(outcome.status)}</li>)}</ul>}
        <Button onClick={() => { void retry() }}>{t('retry')}</Button>
      </div>}
      {state.saved && <p role="status">{t('success')}</p>}
    </section>
    <section className={css.choice}>
      <h3>{t('configuration')}</h3>
      <p>{t('configurationHint')}</p>
      {inspection.status === 'loading' && <p role="status">{t('inspectionLoading')}</p>}
      {inspection.status === 'error' && <p role="alert">{t('inspectionError')}</p>}
      {files && <>
        <h4>{t('settingsFile')}</h4>
        <p>{files.settingsFile}</p>
        <p>{t('directory')}: {files.settingsDirectory}</p>
        <div className={css.modes}>
          <Button disabled={openingPath || inspection.status !== 'ready'} onClick={() => { void open(files.settingsFile, 'open') }}>{t('openFile')}</Button>
          <Button disabled={openingPath || inspection.status !== 'ready'} onClick={() => { void open(files.settingsFile, 'reveal') }}>{t('openDirectory')}</Button>
        </div>
      </>}
      {pathFailure && <p role="alert">{t('pathError')}</p>}
    </section>
    <details className={css.choice}><summary>{t('advanced')}</summary>
      {files && <>
        <h4>{t('catalogFile')}</h4>
        <p>{t('catalogHint')}</p>
        {catalogFile == null ? <p>{t('catalogUnavailable')}</p> : <>
          <p>{catalogFile}</p>
          <p>{t('directory')}: {files.catalogDirectory}</p>
          <div className={css.modes}>
            <Button disabled={openingPath || inspection.status !== 'ready'} onClick={() => { void open(catalogFile, 'open') }}>{t('openFile')}</Button>
            <Button disabled={openingPath || inspection.status !== 'ready'} onClick={() => { void open(catalogFile, 'reveal') }}>{t('openDirectory')}</Button>
          </div>
        </>}
      </>}
      {pathFailure && <p role="alert">{t('pathError')}</p>}
      <p role="status">{t('engineStatus')}: {inspection.status === 'ready' && files ? t(files.engine === 'unavailable' ? 'engineUnavailable' : files.engine) : t('engineUnknown')}</p>
      <Button disabled={inspection.status === 'loading'} onClick={() => { void refresh() }}>{t('refresh')}</Button>
      <p>{t('otherSettings')}</p>
    </details>
  </div>
}
