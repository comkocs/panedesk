/** Workflow drafts, quick access, and their product-owned settings page. */
import { useState } from 'react'
import { Button, Menu, SettingsPageHeader, Switch } from '@panedesk/dsh-client-ui-primitives'
import type { InputActions } from '@panedesk/dsh-client-ui-conversation/client'
import { workflowChoices, workflowDefaults } from '../workflow-defaults.ts'
import type { WorkflowPrompts } from '../workflow-defaults.ts'
import type { WorkflowSettingsProps, WorkflowStarterProps, WorkflowQuickProps } from './props.ts'
import css from './ProjectGuide.module.css'

/** Insert a workflow draft through the existing composer actions, without sending.
 * @param actions - Current occurrence's input actions.
 * @param text - Saved localized opening prompt.
 * @returns Whether the composer accepted the insertion.
 */
export function insertWorkflow(actions: InputActions, text: string): boolean {
  const span = actions.captureInsertion()
  if (!actions.insertText(text, span)) return false
  actions.persistDraft()
  actions.focus()
  return true
}

/** Offer workflow drafts before the first edit or message in a new session.
 * @param props - Session input and the shared workflow configuration.
 * @returns Three optional starters, a reset action after selection, or nothing after sending.
 */
export function WorkflowStarters({ session, input, inputActions, useWorkflow, useWorkflowLocale, t }: WorkflowStarterProps) {
  const form = useWorkflow(value => value.value)
  const language = useWorkflowLocale(value => value.active === 'zh' ? 'zh' : 'en')
  const [starterRevision, setStarterRevision] = useState<number | null>(0)
  if (form?.showWorkflowStarters !== true || !session.blank || session.promptAttempted || input.phase !== 'plain') return null
  if (starterRevision === null) return <Button variant="outline" size="sm" onClick={() => {
    inputActions.setDraft('')
    inputActions.persistDraft()
    inputActions.focus()
    setStarterRevision(inputActions.captureInsertion().draftRev)
  }}>{t('chooseAnother')}</Button>
  if (input.draftRev !== starterRevision) return null
  return <section className={css.starters} aria-label={t('startersTitle')}>
    <p>{t('startersTitle')}</p>
    <div className={css.starterChoices}>
      {workflowChoices.map(([label, hint, key]) => <Button key={key} variant="outline"
        className={css.starter} onClick={() => {
          if (insertWorkflow(inputActions, form[key][language])) setStarterRevision(null)
        }}>
        <span>{t(label)}</span><span className={css.starterHint}>{t(hint)}</span>
      </Button>)}
    </div>
  </section>
}

/** Blank-session menu remains available independently of the central starter switch.
 * @param props - Shared workflow settings, standard composer actions, and navigation.
 * @returns Three draft actions followed by a direct settings link.
 */
export function WorkflowQuick({ useWorkflow, useWorkflowLocale, inputActions, manageWorkflow, t }: WorkflowQuickProps) {
  const form = useWorkflow(value => value.value)
  const language = useWorkflowLocale(value => value.active === 'zh' ? 'zh' : 'en')
  const [open, setOpen] = useState(false)
  return <Menu open={open} onClose={() => setOpen(false)} portal align="end" autoFocus
    anchor={<Button variant="outline" size="sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{t('workflowTitle')}</Button>}
    items={[...workflowChoices.map(([label, , key]) => ({ id: key, label: t(label), disabled: !form || !inputActions })),
      { type: 'separator', id: 'settings-separator' }, { id: 'settings', label: t('workflowSettings') }]}
    onSelect={id => {
      setOpen(false)
      if (id === 'settings') manageWorkflow()
      else if (form && inputActions) insertWorkflow(inputActions, form[id as keyof WorkflowPrompts][language])
    }} />
}

function PromptField({ text, label, restore, save, disabled, t }: {
  text: string; label: string; restore: string; save: (text: string) => Promise<boolean>; disabled: boolean
  t: WorkflowSettingsProps['t']
}) {
  const [draft, setDraft] = useState(text)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const persist = async (value: string) => {
    setBusy(true)
    try {
      const saved = await save(value)
      setFailed(!saved)
      if (saved) setDraft(value)
    } finally { setBusy(false) }
  }
  return <section className={css.choice}>
    <label className={css.promptField}>{label}<textarea value={draft} disabled={disabled || busy} onChange={event => setDraft(event.target.value)} /></label>
    <div className={css.modes}>
      <Button variant="primary" disabled={disabled || busy} onClick={() => { void persist(draft) }}>{t('save')}</Button>
      <Button variant="outline" disabled={disabled || busy} onClick={() => { void persist(restore) }}>{t('restoreDefault')}</Button>
    </div>
    {failed && <p role="alert">{t('error')}</p>}
  </section>
}

/** Edit workflow visibility and three localized prompts in the Panedesk group.
 * @param props - Shared configuration form, localized copy, and settings writers.
 * @returns Standard three-line header, visibility switch, and per-prompt save/reset actions.
 */
export function WorkflowSettings({ useWorkflow, useWorkflowLocale, setEnabled, setPrompt, t }: WorkflowSettingsProps) {
  const form = useWorkflow(value => value)
  const language = useWorkflowLocale(value => value.active === 'zh' ? 'zh' : 'en')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const save = async (enabled: boolean) => {
    setBusy(true)
    try { setFailed(!await setEnabled(enabled)) }
    finally { setBusy(false) }
  }
  return <div className={css.page}>
    <SettingsPageHeader what={t('workflowWhat')} whether={t('workflowWhether')} ai={t('workflowAi')}
      labels={{ what: t('headerWhat'), whether: t('headerWhether'), ai: t('headerAi'), copy: t('copy'), copied: t('copied'), copyFailed: t('copyFailed'), once: t('once') }} />
    <Switch checked={form.value?.showWorkflowStarters === true} label={t('showWorkflowStarters')}
      disabled={busy || form.status !== 'ready' || !form.writable} onChange={enabled => { void save(enabled) }} />
    {form.status === 'ready' && form.value && workflowChoices.map(([label, , key]) => <PromptField key={`${key}:${language}`}
      label={t(label)} text={form.value![key][language]} restore={workflowDefaults[key][language]}
      disabled={!form.writable} save={text => setPrompt(key, language, text)} t={t} />)}
    {failed && <p role="alert">{t('error')}</p>}
  </div>
}
