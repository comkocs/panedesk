/** First-entry modal and product-owned project settings presentation. */
import { useState } from 'react'
import { Button, Modal } from '@panedesk/dsh-client-ui-primitives'
import type { ProjectSelection } from '../types.ts'
import type { GuideProps } from './props.ts'
import type { PropsLocale } from '@panedesk/dsh-client-ui-slots'
import type { ProjectPreferences } from './controller.ts'
import type { WELCOME_NOTICE_VERSION } from '@panedesk/dsh-client-ui-settings-models/src/onboarding-copy.ts'
import css from './ProjectGuide.module.css'

type ChoiceProps = PropsLocale<'projectOnboarding'> & {
  path: string
  state: ProjectPreferences
  select: (path: string, mode: ProjectSelection['mode']) => Promise<boolean>
}

function ProjectChoice({ path, state, select, t }: ChoiceProps) {
  const committed = state.projects[path]?.mode ?? 'remind'
  const [draft, setDraft] = useState<ProjectSelection['mode']>(committed)
  return <section className={css.choice}>
    <p>{path}</p>
    <p>{t('intro')}</p>
    <div className={css.modes}>
      {(['off', 'remind', 'auto'] as const).map(mode => <div key={mode}>
        <Button variant={draft === mode ? 'primary' : 'outline'} aria-pressed={draft === mode}
          disabled={!state.writable || state.status !== 'ready'} onClick={() => { setDraft(mode) }}>{t(mode)}</Button>
        <p>{t(`${mode}Hint`)}</p>
      </div>)}
    </div>
    {!state.writable && <p role="status">{t('readonly')}</p>}
    {state.error && <div role="alert"><p>{t(state.compensation ? 'compensation' : 'error')}</p>
      {state.compensation && <ul>{state.compensation.map(outcome =>
        <li key={outcome.projectId}>{outcome.projectId}: {t(outcome.status)}</li>)}</ul>}
    </div>}
    {state.saved && <p role="status">{t('success')}</p>}
    <Button disabled={!state.writable || state.status !== 'ready'} onClick={() => { void select(path, draft) }}>
      {t(state.status === 'saving' ? 'saving' : 'save')}
    </Button>
  </section>
}

// Keep the preference comparison aligned with the notice without importing another UI plugin at runtime.
const welcomeVersion: typeof WELCOME_NOTICE_VERSION = '2026-09-28.1'

/** Render project guidance after the welcome notice and the blank main Session.
 * @param props Framework hooks, localized copy, and preference callbacks.
 * @returns A modal for an unchosen project, otherwise no added interface.
 */
export function ProjectGuide(props: GuideProps) {
  const { usePreferences, useWelcome, useWorkspaces, useSessions, sessionId, select, retry, inputActions, t } = props
  const state = usePreferences(value => value)
  const welcomeComplete = useWelcome(value => value.status === 'ready' && value.value?.welcomeNoticeVersion === welcomeVersion)
  const projectActive = useSessions((value) => {
    const main = Object.values(value.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)
    return value.phase === 'ready' && main !== undefined && !main.blank
  })
  const workspace = useWorkspaces(value => value.items.find(item => item.sessionIds.includes(sessionId)))
  const cwd = useSessions(value => value.byId[sessionId]?.cwd)
  const path = workspace?.path ?? cwd
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [insertFailed, setInsertFailed] = useState(false)
  if (!welcomeComplete || !projectActive || path === undefined || state.projects[path]?.chosen || dismissed === path) return null
  if (state.status === 'loading') return null
  const close = () => { setDismissed(path) }
  const start = () => {
    const span = inputActions.captureInsertion()
    const inserted = inputActions.insertText(t('request'), span)
    if (inserted) { inputActions.persistDraft(); close() }
    else setInsertFailed(true)
  }
  return <Modal open title={t('title')} closeLabel={t('close')} onClose={close}>
    {state.status === 'error'
      ? <><p role="alert">{t('error')}</p><Button onClick={() => { void retry() }}>{t('retry')}</Button></>
      : <ProjectChoice key={path} path={path} state={state} select={select} t={t} />}
    <Button onClick={start}>{t('start')}</Button>
    <p>{t('startHint')}</p>
    {insertFailed && <p role="alert">{t('unavailable')}</p>}
  </Modal>
}

