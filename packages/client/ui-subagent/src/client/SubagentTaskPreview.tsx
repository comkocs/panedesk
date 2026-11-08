/** Bounded task-flow preview over the same retained child and Chat target as its detail view. */
import { useMemo } from 'react'
import type { FactoryComponentPropsOf, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
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
  const reason = latest?.end?.data.reason.kind
  const activity = running ? t('activity.running') : reason === 'error' ? t('activity.failed')
    : reason === 'completed' ? t('activity.completed') : status
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
      <PreviewHeading label={label} status={activity} metrics={metrics} model={selection?.lastUsed?.model} />
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
