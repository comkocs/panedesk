/** Secondary node settings render framework resources and confirm every existing operator action. */
import { useState } from 'react'
import { Button, Modal } from '@panedesk/dsh-client-ui-primitives'
import { IconPanedeskNode } from '@panedesk/dsh-client-ui-panedesk-icons'
import { randomUUID } from '@panedesk/dsh-util-crypto'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { NodeAction, NodeActionResult } from '../types.ts'
import type { NodesActions, NodesData } from './index.ts'
import type { NodesKey } from './locales.ts'
import css from './section.module.css'

type Props = PropsRuntime<'settings.section'> & PropsLocale<'nodes'> & InjectFace<NodesActions>
function stateKey(status: string, value: NodesData | undefined, code: string | undefined): NodesKey {
  if (code === 'nodes/unauthorized') return 'unauthorized'
  if (code === 'nodes/disabled') return 'disabled'
  if (status === 'failed') return 'error'
  if (status === 'loading') return 'loading'
  if (!value) return 'idle'
  return value.view.nodes.length + value.view.callbacks.length + value.view.sourceOperations.length === 0 ? 'empty' : 'success'
}

/** Render local-to-peer health, process-local events and bounded parked work with confirmed actions.
 * @param props - Framework resources, locale and narrowly scoped operator callback.
 * @returns Settings-only node page and a shared confirmation modal.
 */
export function NodesSection({ useResource, t, act }: Props) {
  const [refresh, setRefresh] = useState(0)
  const [confirmation, setConfirmation] = useState<{ action: NodeAction; target: string } | null>(null)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<NodeActionResult | null>(null)
  const resource = useResource<'nodes'>(`dsh-resource://nodes/view?refresh=${refresh}`)
  const view = resource.status === 'failed' ? undefined : resource.value?.view
  const text = (value: string | number | null | undefined) => value === null || value === undefined ? t('unknown') : String(value)
  const count = (value: number | null | undefined, atLeast: boolean | undefined) => value === null || value === undefined
    ? t('unknown') : atLeast ? t('atLeast', { count: value }) : String(value)
  const confirm = async () => {
    if (!confirmation || pending) return
    setPending(true); setResult(null)
    try { setResult(await act(confirmation.action)); setRefresh(value => value + 1) }
    catch (_error: unknown) { setResult({ status: 'uncertain' }) }
    finally { setPending(false); setConfirmation(null) }
  }
  const sourceAction = (key: string, action: 'resume' | 'abandon'): NodeAction => ({ kind: 'source', action, key,
    operationId: randomUUID(), reason: t('operatorReason') })
  const actions = (resume: NodeAction, abandon: NodeAction, target: string) => <div className={css.actions}>
    <Button disabled={pending} onClick={() => { setConfirmation({ action: resume, target }) }}>{t('resume')}</Button>
    <Button variant="outline" disabled={pending} onClick={() => { setConfirmation({ action: abandon, target }) }}>{t('abandon')}</Button>
  </div>
  return <section className={css.section}>
    <header><h2><IconPanedeskNode size={20} /> {t('title')}</h2><Button disabled={pending} onClick={() => { setRefresh(value => value + 1) }}>{t('refresh')}</Button></header>
    <p>{t('description')}</p>
    <p role={resource.status === 'failed' ? 'alert' : 'status'}>{t(stateKey(resource.status, resource.value, resource.failure?.code))}</p>
    {pending && <p role="status">{t('pending')}</p>}
    {result && <p role={result.status === 'ok' ? 'status' : 'alert'}>{t(result.status === 'ok' ? 'actionSuccess' : result.status === 'uncertain' ? 'uncertain' : 'failed')}
      {result.code && <> {t('resultCode')}: {result.code}</>}</p>}
    <p>{t('direction')}</p><p>{t('remoteOnly')}</p><p>{t('sinceStart')}</p>
    {view?.nodes.map(node => <article key={node.nodeId} className={css.card}>
      <h3>{node.nodeName} · {t(node.local ? 'local' : 'remote')}</h3>
      <dl><dt>{t('engine')}</dt><dd>{t(node.engine)}</dd>
        <dt>{t('windows')}</dt><dd>{text(node.openWindows)} / {text(node.limit)}</dd>
        <dt>{t('heartbeat')}</dt><dd>{text(node.lastHeartbeatAt)}</dd></dl>
      <p>{t(node.linkState === 'local' ? 'localLink' : node.linkState)} {node.safeReason}</p>
      {node.linkState === 'exhausted' && node.rebuildable && <Button disabled={pending} onClick={() => {
        setConfirmation({ action: { kind: 'rebuild', peerNodeId: node.nodeId }, target: node.nodeName })
      }}>{t('rebuild')}</Button>}
      <details><summary>{t('events')}</summary>{node.events.length === 0 ? <p>{t('noEvents')}</p>
        : <ol>{node.events.map(event => <li key={event.sequence}><time>{event.at}</time> · {t(event.kind === 'rebuild' ? 'rebuildEvent' : event.kind)} {event.safeReason}</li>)}</ol>}</details>
    </article>)}
    <h3>{t('callbacks')}</h3>
    {view && !view.callbacksAvailable && <p role="status">{t('callbacksUnavailable')}</p>}
    {view?.callbacksAvailable && !view.callbacksComplete && <p role="status">{t('partial')}</p>}
    {view && !view.sourceAvailable && <p role="status">{t('sourceUnavailable')}</p>}
    {view?.sourceAvailable && <p>{t('sourceBounded')}</p>}
    {view && view.callbacks.length + view.sourceOperations.length === 0 && <p>{t('noCallbacks')}</p>}
    {view?.callbacks.map(item => <article key={item.callbackId} className={css.card}>
      <h4>{item.callbackId}</h4><dl>
        <dt>{t('source')}</dt><dd>{item.source}</dd><dt>{t('target')}</dt><dd>{item.target}</dd>
        <dt>{t('parking')}</dt><dd>{text(item.parkingCode)}</dd><dt>{t('detail')}</dt><dd>{text(item.detail)}</dd>
        <dt>{t('first')}</dt><dd>{text(item.firstAttemptAt)}</dd><dt>{t('last')}</dt><dd>{text(item.lastAttemptAt)}</dd>
        <dt>{t('count')}</dt><dd>{count(item.count, item.attemptsAtLeast)}</dd><dt>{t('latest')}</dt><dd>{text(item.latestReason)}</dd>
      </dl>{actions({ kind: 'callback', request: { callbackId: item.callbackId, expectedAttempt: item.attempt, action: 'resume' } },
        { kind: 'callback', request: { callbackId: item.callbackId, expectedAttempt: item.attempt, action: 'abandon' } }, item.callbackId)}
    </article>)}
    {view?.sourceOperations.map(item => <article key={item.key} className={css.card}>
      <h4>{item.eventId}</h4><dl><dt>{t('source')}</dt><dd>{text(item.observation?.source)}</dd>
        <dt>{t('target')}</dt><dd>{item.target}</dd><dt>{t('parking')}</dt><dd>{item.observation?.parkingCode ?? item.state}</dd>
        <dt>{t('detail')}</dt><dd>{text(item.detail)}</dd>
        <dt>{t('first')}</dt><dd>{text(item.observation?.firstAttemptAt)}</dd>
        <dt>{t('last')}</dt><dd>{text(item.observation?.lastAttemptAt)}</dd>
        <dt>{t('count')}</dt><dd>{count(item.observation?.count, item.observation?.attemptsAtLeast)}</dd>
        <dt>{t('latest')}</dt><dd>{text(item.observation?.latestReason)}</dd></dl>
      {actions(sourceAction(item.key, 'resume'), sourceAction(item.key, 'abandon'), item.eventId)}
    </article>)}
    <Modal open={confirmation !== null} onClose={() => { if (!pending) setConfirmation(null) }} title={t('confirm')}
      closeLabel={t('close')} description={t('confirmDescription')}
      footer={<div className={css.actions}><Button disabled={pending} onClick={() => { setConfirmation(null) }}>{t('cancel')}</Button>
        <Button disabled={pending} onClick={() => { void confirm() }}>{t('confirm')}</Button></div>}>
      {confirmation && <p>{t(confirmation.action.kind === 'rebuild' ? 'rebuild'
        : confirmation.action.kind === 'callback' ? confirmation.action.request.action : confirmation.action.action)} · {confirmation.target}</p>}
    </Modal>
  </section>
}
