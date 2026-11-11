/** Workspace-local verification controls; draft state belongs only to this mounted page. */
import { useState } from 'react'
import { Button, Input, Menu } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { WorkspaceId } from '@panedesk/dsh-workspace/types'
import type { VerificationSettings, VerificationPreset } from '@panedesk/dsh-verification-policy/types'
import type { VerificationActions } from './index.ts'

type Props = PropsRuntime<'settings.section'> & PropsLocale<'verification'> & InjectFace<VerificationActions>

/** Render workspace selection and its versioned settings editor.
 * @param props Framework workspace/resource hooks and save action.
 * @returns Workspace picker and keyed editor.
 */
export function VerificationPage(props: Props) {
  const workspaces = props.useWorkspaces(value => value.items)
  const [selected, setSelected] = useState<WorkspaceId | null>(null)
  const [menu, setMenu] = useState(false)
  const workspace = workspaces.find(item => item.workspaceId === selected) ?? workspaces[0]
  return <section>
    <Menu open={menu} portal onClose={() => { setMenu(false) }} selectedId={workspace?.workspaceId}
      anchor={<Button variant="outline" aria-label={props.t('workspace')} onClick={() => { setMenu(true) }}>{workspace?.title ?? props.t('chooseWorkspace')}</Button>}
      items={workspaces.map(item => ({ id: item.workspaceId, label: item.title }))}
      onSelect={id => { setSelected(id as WorkspaceId); setMenu(false) }} />
    {workspace && <WorkspaceEditor key={workspace.workspaceId} {...props} workspaceId={workspace.workspaceId} />}
  </section>
}

function WorkspaceEditor({ useResource, save, t, workspaceId }: Props & { workspaceId: WorkspaceId }) {
  const [revision, setRevision] = useState(0)
  const resource = useResource<'verification'>(`dsh-resource://verification/${encodeURIComponent(workspaceId)}?revision=${revision}`)
  const [draft, setDraft] = useState<VerificationSettings | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<'saved' | 'error' | null>(null)
  const [failure, setFailure] = useState('')
  const settings = draft ?? resource.value?.settings
  if (!settings) return <p role={resource.status === 'failed' ? 'alert' : 'status'}>{resource.status === 'failed' ? t('error', { reason: resource.failure!.message }) : t('loading')}</p>
  const presets = resource.value!.presets
  const preset = (Object.keys(presets) as VerificationPreset[]).find(id => JSON.stringify(presets[id]) === JSON.stringify(settings)) ?? 'custom'
  const update = (change: Partial<VerificationSettings>) => { setDraft({ ...settings, ...change }); setMessage(null) }
  const number = (value: string): number | null => value === '' ? null : Number(value)
  return <section>
    <h2>{t('title')}</h2><p>{t('scope')}</p>
    <label><input type="checkbox" checked={settings.enabled} onChange={event => { update({ enabled: event.target.checked }) }} />{t('enabled')}</label>
    <p>{t('enabledHint')}</p>
    <Menu open={menu === 'preset'} portal onClose={() => { setMenu(null) }} selectedId={preset}
      anchor={<Button variant="outline" aria-label={t('preset')} onClick={() => { setMenu('preset') }}>{t(preset)}</Button>}
      items={[...Object.keys(presets) as VerificationPreset[], 'custom' as const].map(id => ({ id, label: t(id) }))}
      onSelect={id => { if (id !== 'custom') setDraft(presets[id as VerificationPreset]); setMenu(null) }} />
    <fieldset disabled={!settings.enabled || busy}>
      <legend>{t('title')}</legend>
      <Menu open={menu === 'fullTests'} portal onClose={() => { setMenu(null) }} selectedId={settings.fullTests}
        anchor={<Button variant="outline" aria-label={t('fullTests')} onClick={() => { setMenu('fullTests') }}>{t('fullTests')}: {t(settings.fullTests)}</Button>}
        items={(['allow', 'once', 'deny'] as const).map(id => ({ id, label: t(id) }))}
        onSelect={id => { update({ fullTests: id as VerificationSettings['fullTests'] }); setMenu(null) }} />
      {(['mutation', 'scripts', 'ci', 'focusedTests'] as const).map(key => <p key={key}><label>
        <input type="checkbox" checked={settings[key]} onChange={event => { update({ [key]: event.target.checked }) }} />{t(key)}
      </label></p>)}
      <label>{t('clientMinutes')}<Input type="number" min="0.01" step="any" value={settings.clientMinutes ?? ''}
        onChange={event => { update({ clientMinutes: number(event.target.value) }) }} /></label>
      <p>{t('limitHint')}</p>
      {(['minutes', 'percent'] as const).map(key => <p key={key}><label>{t(key)}<Input type="number" min={key === 'percent' ? 0 : 0.01}
        max={key === 'percent' ? 100 : undefined} step="any" value={settings.budget[key] ?? ''}
        onChange={event => { update({ budget: { ...settings.budget, [key]: number(event.target.value) } }) }} /></label></p>)}
      <Menu open={menu === 'action'} portal onClose={() => { setMenu(null) }} selectedId={settings.budget.action}
        anchor={<Button variant="outline" aria-label={t('action')} onClick={() => { setMenu('action') }}>{t(settings.budget.action === 'ask' ? 'ask' : 'block')}</Button>}
        items={[{ id: 'ask', label: t('ask') }, { id: 'deny', label: t('block') }]}
        onSelect={id => { update({ budget: { ...settings.budget, action: id as 'ask' | 'deny' } }); setMenu(null) }} />
      <p>{t('approvalHint')}</p>
    </fieldset>
    <Button variant="primary" disabled={busy} onClick={() => {
      setBusy(true); setMessage(null)
      void save({ workspaceId, settings }).then(result => {
        if (!result.ok) { setFailure(result.error.message); setMessage('error'); return }
        setDraft(result.value.settings); setRevision(value => value + 1); setMessage('saved')
      }).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)); setMessage('error') }).finally(() => { setBusy(false) })
    }}>{t('save')}</Button>
    {message && <p role={message === 'error' ? 'alert' : 'status'}>{message === 'error' ? t('error', { reason: failure }) : t('saved')}</p>}
    <p>{t('limits')}</p>
  </section>
}
