/** Right-sidebar verification checklist: requirements and checks, rolled up from child sessions. */
import { useState } from 'react'
import { Button } from '@panedesk/dsh-client-ui-primitives'
import type { ActivityCategory, ActivityTotal } from '@panedesk/dsh-activity-category/types'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { VerificationSettings } from '@panedesk/dsh-verification-policy/types'
import type { VerificationChecklistCategory, VerificationChecklistItem, VerificationChecklistSubmission } from '@panedesk/dsh-tool-verification-checklist/client'
import type { SubagentTreeData } from '@panedesk/dsh-client-ui-subagent-tree/client'
import type { VerificationChecklistKey } from './locales.ts'
import css from './panel.module.css'

/** One node of the shared subagent tree resource. */
type TreeNode = SubagentTreeData['root']

/** Registration-side face for opening the checklist tab of one session. */
export interface VerificationChecklistActions {
  /** Open this session's checklist page in the right sidebar. */
  open(this: void, sessionId: SessionId): void
}

/** Registration-side face for recording one prohibition. */
export interface VerificationChecklistLabels {
  /** Append one category to the exact task's prohibitions. */
  prohibit(this: void, sessionId: SessionId, taskId: string, category: ActivityCategory): Promise<void>
}

/** Full props for the session-header checklist pill. */
export type VerificationChecklistActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'verificationChecklist'>
  & InjectFace<VerificationChecklistActions>

/** Full props for the right-sidebar checklist tab body. */
export type VerificationChecklistTabProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'verificationChecklist'>
  & InjectFace<VerificationChecklistLabels>

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
export function forbiddenCategories(settings: VerificationSettings | undefined): ReadonlySet<ActivityCategory> {
  const value = settings ?? DEFAULT_SETTINGS
  const denied = new Set<ActivityCategory>()
  if (value.fullTests === 'deny') denied.add('test-full')
  if (!value.mutation) denied.add('mutation')
  if (!value.scripts) denied.add('script')
  if (!value.ci) denied.add('ci')
  if (!value.focusedTests) denied.add('test-focused')
  return denied
}

/** Format elapsed milliseconds as minutes and seconds.
 * @param milliseconds Observed duration.
 * @returns Zero-padded mm:ss.
 */
function checklistTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** One session's checklist contribution inside the panel. */
interface ChecklistSource {
  sessionId: SessionId
  checklists: readonly VerificationChecklistSubmission[]
  totals: readonly ActivityTotal[] | undefined
  taskId: string | undefined
}

/**
 * Session-header pill that opens this session's checklist page.
 * @param props Session standard props, localized copy, and the open action.
 * @returns One toolbar button, or null for the minimal preset.
 */
export function VerificationChecklistAction({ sessionId, useSessions, t, open }: VerificationChecklistActionProps) {
  const minimal = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset === 'minimal')
  if (minimal) return null
  return <Button variant="toolbar" size="sm" className={css.pill} onClick={() => { open(sessionId) }}>{t('title')}</Button>
}

/**
 * Right-sidebar checklist: this session and its descendants, grouped by requirement title.
 * @param props Framework tab props, localized copy, and the prohibition action.
 * @returns Requirement groups with one checkbox per declared check.
 */
export function VerificationChecklistTab({ sessionId, useTabInfo, useSessions, useWorkspaces, useResource, t, prohibit }: VerificationChecklistTabProps) {
  const { tab } = useTabInfo()
  const sessions = useSessions(state => state.byId)
  const workspaces = useWorkspaces(state => state.items)
  const tree = useResource<'subagenttree'>(`dsh-resource://subagenttree/session/${encodeURIComponent(sessionId)}`)
  const sources = collectSources(sessionId, sessions, tree.value?.root)
  const workspaceId = workspaceOf(sessionId, sessions, workspaces)
  const resource = useResource<'verification'>(workspaceId === undefined ? '' : `dsh-resource://verification/${encodeURIComponent(workspaceId)}`)
  const forbidden = forbiddenCategories(resource.value?.settings)
  const groups = groupByTitle(sources)
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState(false)
  return <section className={css.tab} data-verification-checklist={tab.contentId}>
    <h1 className={css.heading}>{t('title')}</h1>
    <p>{t('description')}</p>
    {resource.status === 'loading' && <p role="status">{t('loading')}</p>}
    {resource.status === 'failed' && <p role="alert">{t('failed')}</p>}
    {failed && <p role="alert">{t('prohibitFailed')}</p>}
    {groups.length === 0 && <p>{t('empty')}</p>}
    {groups.map(group => <section key={group.title} className={css.group}>
      <h2>{group.title}</h2>
      <ul>{group.checks.map(check => {
        const key = `${check.source.sessionId}\u0000${group.title}\u0000${check.item.category}`
        const denied = forbidden.has(check.item.category)
        const total = check.source.totals?.find(row => row.category === check.item.category)
        return <li key={key} className={denied ? `${css.item} ${css.muted}` : css.item}>
          <label>
            <input type="checkbox" checked={!unchecked.has(key)} disabled={denied || check.source.taskId === undefined || unchecked.has(key)}
              onChange={() => {
                const current = check.source.taskId
                if (current === undefined || unchecked.has(key)) return
                setFailed(false)
                void prohibit(check.source.sessionId, current, check.item.category)
                  .then(() => { setUnchecked(ids => new Set(ids).add(key)) })
                  .catch((_error: unknown) => { setFailed(true) })
              }} />
            {check.item.note}
          </label>
          <small>{t('estimated', { minutes: String(check.item.minutes) })} · {total === undefined ? t('actualUnknown') : t('actual', { time: checklistTime(total.durationMs) })}</small>
          {denied && <small>{t('forbidden')}</small>}
          {check.source.taskId === undefined && !denied && <small>{t('noTask')}</small>}
        </li>
      })}</ul>
      <UndeclaredRows sources={group.sources} declared={group.declared} t={t} />
    </section>)}
  </section>
}

interface GroupedCheck { source: ChecklistSource; item: VerificationChecklistItem }
interface GroupedRequirement {
  title: string
  checks: GroupedCheck[]
  sources: ChecklistSource[]
  declared: Set<VerificationChecklistCategory>
}

/** Categories observed for a requirement's sessions that no submitted check named.
 * @param props The requirement's sessions, its declared categories, and localized copy.
 * @returns One row per undeclared category, or nothing.
 */
function UndeclaredRows({ sources, declared, t }: {
  sources: readonly ChecklistSource[]
  declared: ReadonlySet<VerificationChecklistCategory>
  t: (key: VerificationChecklistKey, values?: Record<string, string>) => string
}) {
  const rows = new Map<ActivityCategory, number>()
  for (const source of sources) {
    for (const total of source.totals ?? []) {
      if (declared.has(total.category as VerificationChecklistCategory)) continue
      if (total.count === 0 && total.durationMs === 0) continue
      rows.set(total.category, (rows.get(total.category) ?? 0) + total.durationMs)
    }
  }
  if (rows.size === 0) return null
  return <ul>{[...rows].map(([category, durationMs]) => <li key={category} className={css.item}>
    <span>{t('undeclared')} · {category}</span>
    <small>{t('actual', { time: checklistTime(durationMs) })}</small>
  </li>)}</ul>
}

/** Group every source's submissions by requirement title, keeping first-seen order.
 * @param sources Sessions that contribute to the panel.
 * @returns One group per distinct title.
 */
function groupByTitle(sources: readonly ChecklistSource[]): GroupedRequirement[] {
  const groups = new Map<string, GroupedRequirement>()
  for (const source of sources) {
    for (const submission of source.checklists) {
      const group = groups.get(submission.title) ?? { title: submission.title, checks: [], sources: [], declared: new Set<VerificationChecklistCategory>() }
      group.checks.push(...submission.items.map(item => ({ source, item })))
      for (const item of submission.items) group.declared.add(item.category)
      if (!group.sources.includes(source)) group.sources.push(source)
      groups.set(submission.title, group)
    }
  }
  return [...groups.values()]
}

/** One session list row as the checklist reads it. */
interface SessionRow {
  id: SessionId
  parentId?: SessionId
  cwd?: string
  displayTitle: string
  projectionValues?: { verificationChecklists?: readonly VerificationChecklistSubmission[] }
}

/** This session plus every listed descendant, with the activity the one tree resource reports.
 * @param rootId Session the tab was opened for.
 * @param sessions Current session list rows.
 * @param tree Observed activity tree rooted at the same session, when available.
 * @returns One source per session that belongs to the tree.
 */
function collectSources(rootId: SessionId, sessions: Readonly<Record<string, SessionRow>>, tree: TreeNode | undefined): ChecklistSource[] {
  const member = new Set<string>([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const row of Object.values(sessions)) {
      if (row.parentId !== undefined && member.has(row.parentId) && !member.has(row.id)) {
        member.add(row.id)
        grew = true
      }
    }
  }
  return Object.values(sessions).filter(row => member.has(row.id)).map(row => {
    const node = findNode(tree, row.id)
    return {
      sessionId: row.id,
      checklists: row.projectionValues?.verificationChecklists ?? [],
      totals: node?.activity?.totals,
      taskId: node?.verificationTaskId,
    }
  })
}

/** Find one session inside the observed activity tree.
 * @param root Tree root, when the resource has a value.
 * @param sessionId Session to find.
 * @returns The matching node, or undefined.
 */
function findNode(root: TreeNode | undefined, sessionId: SessionId): TreeNode | undefined {
  if (root === undefined) return undefined
  if (root.sessionId === sessionId) return root
  for (const child of root.children) {
    const found = findNode(child, sessionId)
    if (found !== undefined) return found
  }
  return undefined
}

/** Workspace whose record decides grey-out: a member match, else the longest path prefix.
 * @param rootId Session the tab was opened for.
 * @param sessions Current session list rows.
 * @param workspaces Known workspaces.
 * @returns The matching workspace id, or undefined when nothing matches.
 */
function workspaceOf(
  rootId: SessionId,
  sessions: Readonly<Record<string, SessionRow>>,
  workspaces: readonly { workspaceId: string; path: string; sessionIds: readonly SessionId[] }[],
): string | undefined {
  const root = walkRoot(rootId, sessions)
  const member = workspaces.find(item => item.sessionIds.includes(rootId) || item.sessionIds.includes(root))
  if (member !== undefined) return member.workspaceId
  const cwd = sessions[rootId]?.cwd ?? sessions[root]?.cwd
  if (cwd === undefined) return undefined
  return workspaces
    .filter(item => cwd === item.path || cwd.startsWith(`${item.path}/`) || cwd.startsWith(`${item.path}\\`))
    .sort((a, b) => b.path.length - a.path.length)[0]?.workspaceId
}

/** Walk parent links to the oldest known ancestor.
 * @param sessionId Starting session.
 * @param sessions Current session list rows.
 * @returns The root session id.
 */
function walkRoot(sessionId: SessionId, sessions: Readonly<Record<string, { parentId?: SessionId }>>): SessionId {
  let current = sessionId
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    const parent = sessions[current]?.parentId
    if (parent === undefined) return current
    current = parent
  }
  return current
}
