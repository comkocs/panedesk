/** Workspace recording switches. Values live in the project trace service, not in settings storage. */
import { useState } from 'react'
import { Button, Input, Menu } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-workspace/client'
import type {} from '@panedesk/dsh-client-ui-session/client'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { ProjectId, TraceStatus } from '@panedesk/dsh-trace-store/types'
import type { WorkspaceId } from '@panedesk/dsh-workspace/types'
import type { TraceSettingsActions } from './index.ts'

type Props = PropsRuntime<'settings.panedesk.item'> & PropsLocale<'trace'> & InjectFace<TraceSettingsActions>

/** Recording, project link, and strict-mode controls for one workspace.
 * @param props Framework workspace and session hooks plus the trace actions.
 * @returns One Panedesk preference row.
 */
export function TraceSettingsRow(props: Props) {
  const workspaces = props.useWorkspaces(value => value.items)
  const [selected, setSelected] = useState<WorkspaceId | null>(null)
  const [menu, setMenu] = useState(false)
  const workspace = workspaces.find(item => item.workspaceId === selected) ?? workspaces[0]
  return <section>
    <h3>{props.t('settingsTitle')}</h3>
    <p>{props.t('settingsHint')}</p>
    <Menu open={menu} portal onClose={() => { setMenu(false) }} selectedId={workspace?.workspaceId}
      anchor={<Button variant="outline" aria-label={props.t('workspace')} onClick={() => { setMenu(true) }}>{workspace?.title ?? props.t('chooseWorkspace')}</Button>}
      items={workspaces.map(item => ({ id: item.workspaceId, label: item.title }))}
      onSelect={id => { setSelected(id as WorkspaceId); setMenu(false) }} />
    {workspace && <WorkspaceSwitches key={workspace.workspaceId} {...props} workspaceId={workspace.workspaceId} sessionIds={workspace.sessionIds} />}
  </section>
}

function WorkspaceSwitches({ useSessions, useResource, enable, disable, associate, setStrict, t, workspaceId, sessionIds }:
  Props & { workspaceId: WorkspaceId; sessionIds: readonly SessionId[] }) {
  const sessions = useSessions(state => state.byId)
  const [revision, setRevision] = useState(0)
  const resource = useResource<'trace'>(`dsh-resource://trace/${encodeURIComponent(workspaceId)}?revision=${revision}`)
  const [override, setOverride] = useState<TraceStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [plannerMenu, setPlannerMenu] = useState(false)
  const status = override ?? resource.value?.status ?? null
  const windows = sessionIds.filter(id => sessions[id]?.origin !== 'subagent')
  const apply = (next: Promise<TraceStatus | null>): void => {
    setFailed(false)
    void next.then(value => { setOverride(value); setFailed(value === null); if (value !== null) setRevision(current => current + 1) })
  }
  const enabled = status?.enabled === true
  const planner = windows.find(id => id === status?.plannerSessionId)
  return <section>
    <label><input type="checkbox" checked={enabled} disabled={status === null}
      onChange={event => { apply(event.target.checked ? enable(workspaceId) : disable(workspaceId)) }} />{t('enabled')}</label>
    <h4>{t('associate')}</h4>
    <p>{t('associateHint')}</p>
    <label>{t('projectId')}<Input value={projectId} onChange={event => { setProjectId(event.target.value) }} /></label>
    <Button variant="outline" disabled={projectId.trim() === ''}
      onClick={() => { apply(associate(workspaceId, projectId.trim() as ProjectId)) }}>{t('associateAction')}</Button>
    <h4>{t('strict')}</h4>
    <p>{t('strictHint')}</p>
    <label><input type="checkbox" checked={status?.strict === true} disabled={!enabled}
      onChange={event => { apply(setStrict(workspaceId, event.target.checked, event.target.checked ? planner ?? windows[0] ?? null : null)) }} />{t('strict')}</label>
    <Menu open={plannerMenu} portal onClose={() => { setPlannerMenu(false) }} selectedId={planner}
      anchor={<Button variant="outline" aria-label={t('planner')} disabled={!enabled || status?.strict !== true}
        onClick={() => { setPlannerMenu(true) }}>{planner === undefined ? t('plannerNone') : sessions[planner]?.displayTitle ?? planner}</Button>}
      items={windows.map(id => ({ id, label: sessions[id]?.displayTitle ?? id }))}
      onSelect={id => { apply(setStrict(workspaceId, true, id as SessionId)); setPlannerMenu(false) }} />
    {windows.length === 0 && <p>{t('noSessions')}</p>}
    {failed && <p role="alert">{t('actionFailed')}</p>}
  </section>
}
