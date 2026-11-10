/** Bounded task-flow preview over the same retained child and Chat target as its detail view. */
import { useMemo } from 'react'
import type { FactoryComponentPropsOf, PropsLocale, PropsRenderFactories, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import { Button } from '@panedesk/dsh-client-ui-primitives'
import type {} from '@panedesk/dsh-client-ui-subagent-tree/client'
import type { SubagentCatalogInjected } from './SubagentHeaderLineage.tsx'
import type { SubagentAddress } from '@panedesk/dsh-subagent/client'
import type { ToolCallBlock } from '@panedesk/dsh-client-ui-conversation/client'
import { subagentChatAddress } from './sidebar-chat/index.tsx'
import { NS } from './locales.ts'
import css from './SubagentHeaderLineage.module.css'

interface TaskPreviewInput {
  address: SubagentAddress
  label: string
  status: string
  metrics: string
}

declare module '@panedesk/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    'subagent.task-preview': {
      scope: 'root'
      props: TaskPreviewInput
      locale: typeof NS
      children: { 'subagent.task-preview.flow': { kind: 'single'; scope: 'session' } }
    }
  }
  interface SlotMap {
    'subagent.task-preview.flow': { kind: 'single'; scope: 'session'; owner: TaskPreviewInput }
  }
}

function PreviewHeading({ label, status, metrics, model }: Omit<TaskPreviewInput, 'address'> & { model?: string | undefined }) {
  return <div className={css.previewHeading}>{[label, status, model, metrics].filter(Boolean).join(' · ')}</div>
}

/**
 * Retain only while visible; unavailable history leaves the heading alone.
 * @param props - Task metadata and the framework-bound resource and child renderer.
 * @returns The child-scoped preview or its metadata heading.
 */
export function SubagentTaskPreview({ address, label, status, metrics, useResource, SessionProvider, renderSlot }: FactoryComponentPropsOf<'subagent.task-preview'>) {
  const input = { address, label, status, metrics }
  const resource = useResource<'subagentchat'>(subagentChatAddress(address))
  return <div data-subagent-task-preview="" className={css.taskPreview}>
    {resource.value === undefined
      ? <PreviewHeading {...input} />
      : <SessionProvider session={resource.value.reference}>{renderSlot('subagent.task-preview.flow', input)}</SessionProvider>}
  </div>
}

/**
 * Show the map's task preview and sidebar navigation for a native tree row.
 * @param props - Direct parent and child identity, the owning session, and navigation.
 * @returns The conversation action and its live task preview.
 */
export function SubagentTreeDetails({ parentSessionId, childSessionId, label, close, useSessions,
  openChild, renderFactorySlot, t }: PropsRuntime<'subagent.tree.details'> & PropsRenderFactories
  & PropsLocale<typeof NS> & Pick<SubagentCatalogInjected, 'openChild'>) {
  const mode = useSessions(state => state.projectionsBySession[parentSessionId]?.values.subagentCatalog
    ?.find(entry => entry.id === childSessionId)?.mode ?? 'unknown')
  if (mode === 'external') return null
  const address: SubagentAddress = { parentSessionId, childSessionId, mode }
  return <>
    <Button variant="ghost" onClick={() => { openChild(address); close() }}>{t('map.open')}</Button>
    {renderFactorySlot('subagent.task-preview', { address, label, status: '', metrics: '' })}
  </>
}

function callSummary(call: ToolCallBlock): string {
  for (const key of ['description', 'file_path', 'path', 'command', 'pattern', 'query', 'url']) {
    const value = call.args.textPrefix(key, 160)?.replace(/\s+/g, ' ').trim()
    if (value) return value
  }
  return call.args.keys().slice(0, 4).join(', ')
}

/**
 * Read the detail view's existing Chat publication, never a second history stream.
 * @param props - Task metadata and child-bound Chat, lifecycle, projection, and locale seats.
 * @returns A heading and the latest loaded tool calls, with no full prompt or reply.
 */
export function SubagentTaskFlow({ label, status, metrics, useChat, useProjection, useSession, t }: PropsRuntime<'subagent.task-preview.flow'> & PropsLocale<typeof NS>) {
  const chat = useChat(value => value)
  const open = useSession(value => value.openState === 'open')
  const running = useSession(value => value.running)
  const selection = useProjection('modelSelection')
  const latest = chat.timeline.turns.get(chat.timeline.turnOrder.at(-1) ?? -1)
  const reason = latest?.end?.data.reason
  const activity = running ? t('activity.running') : reason?.kind === 'error' ? t('activity.failed')
    : reason?.kind === 'completed' ? t('activity.completed') : status
  const calls = useMemo(() => {
    const result: ToolCallBlock[] = []
    const append = (call: ToolCallBlock): void => {
      result.push(call)
      for (const child of call.subCalls) append(child)
    }
    for (const node of chat.legacy.nodes) if (node.kind === 'tool-result') append(node)
    for (const call of chat.legacy.runningCalls) append(call)
    const startedAt = (call: ToolCallBlock): number => 'kind' in call ? call.callTime ?? call.time : call.time
    return result.sort((left, right) => startedAt(left) - startedAt(right))
  }, [chat.legacy.nodes, chat.legacy.runningCalls])
  const recent = calls.slice(-20)
  const prompt = chat.navigation.items().at(-1)?.prompt.replace(/\s+/g, ' ').slice(0, 160)
  return (
    <section aria-label={t('preview.title')}>
      <PreviewHeading label={label} status={activity} metrics={metrics} model={selection?.lastUsed == null ? undefined : [selection.lastUsed.provider, selection.lastUsed.model, selection.lastUsed.reasoningEffort].filter(Boolean).join(' · ')} />
      {!running && reason?.kind === 'error' && <div className={css.previewDiagnostic}>{reason.error.message}</div>}
      {open && <>
        {prompt && <div className={css.previewSummary}>{t('preview.prompt', { prompt })}</div>}
        <div className={css.previewSummary}>{t('preview.calls', { shown: recent.length, count: calls.length })}</div>
        <ol className={css.previewCalls}>
          {recent.map(call => <li key={call.callId} className={css.previewCall}>
            <strong>{call.name}</strong>{' '}{callSummary(call)}
          </li>)}
        </ol>
      </>}
    </section>
  )
}
