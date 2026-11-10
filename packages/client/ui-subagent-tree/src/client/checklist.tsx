/** One tree row's verification checklist, shown inside its monitoring details. */
import { useState } from 'react'
import type { ActivityCategory, ActivityTotal } from '@panedesk/dsh-activity-category/types'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { VerificationSettings } from '@panedesk/dsh-verification-policy/types'
import type {} from '@panedesk/dsh-client-ui-settings-verification/client'
import type { VerificationChecklistCategory, VerificationChecklistSubmission } from '@panedesk/dsh-tool-verification-checklist/client'
import { activityTime } from './activity.tsx'
import css from './panel.module.css'

/** Product default used when no workspace record can be read. */
const DEFAULT_SETTINGS: VerificationSettings = {
  version: 1, enabled: true, fullTests: 'once', mutation: false, scripts: true,
  ci: true, focusedTests: true, clientMinutes: null,
  budget: { minutes: null, percent: null, action: 'ask' },
}

/** Categories a workspace record forbids. A missing record uses the product default.
 * @param settings Workspace switches, or undefined before a record is available.
 * @returns Category ids the checklist greys out.
 */
function forbiddenCategories(settings: VerificationSettings | undefined): ReadonlySet<ActivityCategory> {
  const value = settings ?? DEFAULT_SETTINGS
  const denied = new Set<ActivityCategory>()
  if (value.fullTests === 'deny') denied.add('test-full')
  if (!value.mutation) denied.add('mutation')
  if (!value.scripts) denied.add('script')
  if (!value.ci) denied.add('ci')
  if (!value.focusedTests) denied.add('test-focused')
  return denied
}

/** One session list row as the row checklist reads it. */
interface SessionRow {
  id: SessionId
  parentId?: SessionId
  cwd?: string
  projectionValues?: { verificationChecklists?: readonly VerificationChecklistSubmission[] }
}

/**
 * The monitored node's submitted checks and the categories it ran without declaring.
 * @param props Node identity, observed totals, and the framework hooks.
 * @returns The checklist section, or nothing when the node submitted no checklist.
 */
export function NodeChecklist({ sessionId, taskId, totals, useSessions, useWorkspaces, useResource, prohibit, t }: {
  sessionId: SessionId
  taskId: string | undefined
  totals: readonly ActivityTotal[] | undefined
  prohibit(this: void, sessionId: SessionId, taskId: string, category: ActivityCategory): Promise<void>
} & Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useSessions' | 'useWorkspaces' | 'useResource'> & PropsLocale<'subagentTree'>) {
  const sessions = useSessions(state => state.byId)
  const workspaces = useWorkspaces(state => state.items)
  const checklists = sessions[sessionId]?.projectionValues?.verificationChecklists ?? []
  const workspaceId = workspaceOf(sessionId, sessions, workspaces)
  const resource = useResource<'verification'>(workspaceId === undefined ? '' : `dsh-resource://verification/${encodeURIComponent(workspaceId)}`)
  const forbidden = forbiddenCategories(resource.value?.settings)
  const declared = new Set<VerificationChecklistCategory>(checklists.flatMap(list => list.items.map(item => item.category)))
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState(false)
  if (checklists.length === 0 && undeclared(totals, declared).length === 0) return null
  return <section>
    <h3>{t('checklist')}</h3>
    {failed && <p role="alert">{t('checklistFailed')}</p>}
    {checklists.map(list => <section key={list.title}>
      <h4>{list.title}</h4>
      <ul>{list.items.map(item => {
        const key = `${list.title}\u0000${item.category}`
        const denied = forbidden.has(item.category)
        const total = totals?.find(row => row.category === item.category)
        return <li key={key} className={denied ? css.muted : undefined}>
          <label>
            <input type="checkbox" checked={!unchecked.has(key)} disabled={denied || taskId === undefined || unchecked.has(key)}
              onChange={() => {
                if (taskId === undefined || unchecked.has(key)) return
                setFailed(false)
                void prohibit(sessionId, taskId, item.category)
                  .then(() => { setUnchecked(ids => new Set(ids).add(key)) })
                  .catch((_error: unknown) => { setFailed(true) })
              }} />
            {item.note}
          </label>
          <small>{t('checklistEstimated', { minutes: String(item.minutes) })} · {total === undefined ? t('checklistUnknown') : t('checklistActual', { time: activityTime(total.durationMs) })}</small>
          {denied && <small>{t('checklistForbidden')}</small>}
        </li>
      })}</ul>
    </section>)}
    <ul>{undeclared(totals, declared).map(total => <li key={total.category}>
      <span>{t('checklistUndeclared')} · {t(`category.${total.category}`)}</span>
      <small>{t('checklistActual', { time: activityTime(total.durationMs) })}</small>
    </li>)}</ul>
  </section>
}

/** Observed categories the submitted checks never named.
 * @param totals The node's category totals.
 * @param declared Categories named by the node's submissions.
 * @returns Totals that ran without a declaration.
 */
function undeclared(totals: readonly ActivityTotal[] | undefined, declared: ReadonlySet<VerificationChecklistCategory>): ActivityTotal[] {
  return (totals ?? []).filter(total => !declared.has(total.category as VerificationChecklistCategory) && (total.count > 0 || total.durationMs > 0))
}

/** Workspace whose record decides grey-out for one session.
 * @param sessionId The monitored session.
 * @param sessions Current session list rows.
 * @param workspaces Known workspaces.
 * @returns The matching workspace id, or undefined.
 */
function workspaceOf(
  sessionId: SessionId,
  sessions: Readonly<Record<string, SessionRow>>,
  workspaces: readonly { workspaceId: string; path: string; sessionIds: readonly SessionId[] }[],
): string | undefined {
  let root = sessionId
  const seen = new Set<string>()
  while (!seen.has(root) && sessions[root]?.parentId !== undefined) {
    seen.add(root)
    root = sessions[root]!.parentId!
  }
  const member = workspaces.find(item => item.sessionIds.includes(sessionId) || item.sessionIds.includes(root))
  if (member !== undefined) return member.workspaceId
  const cwd = sessions[sessionId]?.cwd ?? sessions[root]?.cwd
  if (cwd === undefined) return undefined
  return workspaces
    .filter(item => cwd === item.path || cwd.startsWith(`${item.path}/`) || cwd.startsWith(`${item.path}\\`))
    .sort((a, b) => b.path.length - a.path.length)[0]?.workspaceId
}
