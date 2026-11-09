/** Optional workflow drafts and their Panedesk feature preference. */
import { useState } from 'react'
import { Button, Switch } from '@panedesk/dsh-client-ui-primitives'
import type { WorkflowSettingsProps, WorkflowStarterProps } from './props.ts'
import css from './ProjectGuide.module.css'

/**
 * Offer workflow drafts only before the first edit or message in a new session.
 * @param props - Session input, localized requests, and the shared preference form.
 * @returns Three optional starters, or no added interface after editing or sending.
 */
export function WorkflowStarters({ session, input, inputActions, useWorkflow, t }: WorkflowStarterProps) {
  const enabled = useWorkflow(form => form.value?.showWorkflowStarters)
  if (enabled !== true || !session.blank || session.promptAttempted || input.draftRev !== 0 || input.phase !== 'plain') return null
  const start = (request: 'request' | 'documentRequest' | 'existingRequest') => {
    const text = t(request)
    const span = inputActions.captureInsertion()
    if (!inputActions.insertText(text, span)) return
    inputActions.persistDraft()
    const placeholder = t('documentPlaceholder')
    const at = text.indexOf(placeholder)
    inputActions.focus(request === 'documentRequest' ? { start: at, end: at + placeholder.length } : undefined)
  }
  return <section className={css.starters} aria-label={t('startersTitle')}>
    <p>{t('startersTitle')}</p>
    <div className={css.starterChoices}>
      {([
        ['newProject', 'newProjectHint', 'request'],
        ['documentedProject', 'documentedProjectHint', 'documentRequest'],
        ['existingProject', 'existingProjectHint', 'existingRequest'],
      ] as const).map(([label, hint, request]) => <Button key={request} variant="outline"
        className={css.starter} onClick={() => { start(request) }}>
        <span>{t(label)}</span><span className={css.starterHint}>{t(hint)}</span>
      </Button>)}
    </div>
  </section>
}

/**
 * Save the workflow-starter preference through the product configuration form.
 * @param props - Shared configuration snapshot, writer, and localized labels.
 * @returns One default-enabled Panedesk feature switch with save feedback.
 */
export function WorkflowStartersSetting({ useWorkflow, setEnabled, t }: WorkflowSettingsProps) {
  const form = useWorkflow(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const save = async (enabled: boolean) => {
    setBusy(true)
    setFailed(false)
    try { setFailed(!await setEnabled(enabled)) }
    finally { setBusy(false) }
  }
  return <div>
    <Switch checked={form.value?.showWorkflowStarters === true} label={t('showWorkflowStarters')}
      disabled={busy || form.status !== 'ready' || !form.writable} onChange={enabled => { void save(enabled) }} />
    {failed && <p role="alert">{t('error')}</p>}
  </div>
}
