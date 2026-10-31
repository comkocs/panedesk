/** Pure approval presentation driven by framework resource reads and plain actions. */
import { useState } from 'react'
import { Button, Modal } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type * as Seat from '@panedesk/dsh-seat'
import type { ApprovalActions } from './index.ts'
import css from './panel.module.css'

type Props = PropsRuntime<'shell.overlay'> & PropsLocale<'seatApprovals'> & InjectFace<ApprovalActions>
type Receipt = { operationId: Seat.SeatOperationId; message: string }

/** Render actual opened evidence separately from the pending preview.
 * @param props - Framework reads, localized text and version-bound mutation actions.
 * @returns a hidden zero-count entry or approval controls and actual opening feedback.
 */
export function ApprovalPanel({ useResource, t, mutate }: Props) {
  const queue = useResource<'seat-approvals'>('dsh-resource://seat-approvals/pending')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<Receipt>()
  const [message, setMessage] = useState<string>()
  const [submitted, setSubmitted] = useState<ReadonlySet<string>>(() => new Set())
  const operation = useResource<'seat-approval-operation'>(receipt
    ? `dsh-resource://seat-approval-operation/${encodeURIComponent(receipt.operationId)}` : '')
  const items = queue.value?.items ?? []
  const outcome = operation.status === 'live' ? operation.value : undefined
  const settled = outcome?.status === 'settled' ? outcome.result : undefined
  const opened = settled?.status === 'opened' && 'result' in settled ? settled.result : settled
  const actual = opened?.status === 'opened' ? opened : undefined
  const budgetText = (budget: Seat.SeatBudgetLimits | undefined): string => {
    const values = []
    if (budget?.windowBudgetUsd !== undefined) values.push(t('windowBudget', { amount: budget.windowBudgetUsd }))
    if (budget?.dailyBudgetUsd !== undefined) values.push(t('dailyBudget', { amount: budget.dailyBudgetUsd }))
    return values.length ? values.join('; ') : t(budget === undefined ? 'absent' : 'unlimited')
  }
  const act = async (item: Seat.PendingSeatItem, action: 'approve' | 'cancel'): Promise<void> => {
    setBusy(true)
    try {
      const { operationId, result } = await mutate(item, action)
      if (!result.ok || result.value.status !== 'rejected') {
        setSubmitted(previous => new Set([...previous, `${item.queueItemId}:${item.stateVersion}`]))
      }
      if (!result.ok) {
        setReceipt({ operationId, message: t('unknown') })
        setMessage(t('unknown'))
      } else if (result.value.status === 'rejected') {
        const error = result.value.error
        setMessage(error.code === 'revision-conflict' ? t('stale')
          : t('rejected', { code: error.code, message: error.message }))
      } else {
        const text = t(action === 'approve' ? 'approved' : 'cancelled')
        setReceipt({ operationId, message: text })
        setMessage(text)
      }
    } finally { setBusy(false) }
  }
  const rejected = queue.value?.rejected ?? []
  if (!items.length && !rejected.length && !receipt && !open && queue.status !== 'failed') return null
  return <div className={css.surface}>
    {(items.length > 0 || rejected.length > 0) && <Button onClick={() => { setOpen(true) }}>{t('available', { count: items.length })}</Button>}
    {!!queue.value?.alerts?.length && <ul aria-live="polite">{queue.value.alerts.map(alert => <li key={alert.id}>{t(alert.phase, { seat: alert.seat })}</li>)}</ul>}
    {queue.status === 'failed' && <p role="alert">{t('failed')}</p>}
    <Modal open={open} onClose={() => { setOpen(false) }} title={t('title')} closeLabel={t('close')}>
      {queue.status !== 'live' && <p role="alert">{t('failed')}</p>}
      {queue.value?.complete === false && <p role="alert">{t('partial')}</p>}
      {!items.length && <p>{t('empty')}</p>}
      {rejected.map(({ item, error }) => <section key={item.queueItemId} className={css.card}>
        <h3>{item.seat}</h3><p>{t('terminal', { code: error.code, message: error.message })}</p>
      </section>)}
      {items.map(item => <section key={item.queueItemId} className={css.card}>
        <p>{t(item.retention ? 'retainedState' : 'pendingState')}</p>
        {item.retention && <p>{t('remaining', { amount: item.retention.remainingMs })}</p>}
        <dl>
          <dt>{t('seat')}</dt><dd>{item.seat}</dd>
          <dt>{t('tasks')}</dt><dd>{item.relatedTaskIds.length ? item.relatedTaskIds.join(', ') : t('absent')}</dd>
          <dt>{t('window')}</dt><dd>{item.windowName ?? t('absent')}</dd>
          <dt>{t('node')}</dt><dd>{item.nodeId ?? t('absent')}</dd>
          <dt>{t('budget')}</dt><dd>{budgetText(item.budget)}</dd>
        </dl>
        <Button disabled={item.reason !== 'approval' || busy || !!receipt && outcome?.status !== 'settled' || submitted.has(`${item.queueItemId}:${item.stateVersion}`) || queue.status !== 'live' || !queue.value?.complete} onClick={() => { void act(item, 'approve') }}>{t('approve')}</Button>
        <Button disabled={busy || !!receipt && outcome?.status !== 'settled' || submitted.has(`${item.queueItemId}:${item.stateVersion}`) || queue.status !== 'live' || !queue.value?.complete} onClick={() => { void act(item, 'cancel') }}>{t('cancel')}</Button>
      </section>)}
      {busy && <p role="status">{t('working')}</p>}
      {message && <p role="status">{message}</p>}
    </Modal>
    {receipt && <section className={css.card} aria-live="polite">
      {operation.status === 'failed' ? <p role="alert">{t('unknown')}</p>
        : actual ? <>
          <h3>{t(actual.phase === 'active' ? 'active' : actual.phase === 'opening-failed' ? 'openingFailed' : 'opened')}</h3>
          <dl><dt>{t('seat')}</dt><dd>{actual.seat}</dd>
            <dt>{t('window')}</dt><dd>{actual.title}</dd>
            <dt>{t('node')}</dt><dd title={actual.nodeId}>{actual.nodeName}</dd>
            <dt>{t('budget')}</dt><dd>{budgetText(actual.budget)}</dd></dl>
          {actual.phase !== 'active' && actual.phase !== 'opening-failed' && <p>{t('opening')}</p>}
        </> : outcome?.status === 'settled' && outcome.result.status === 'rejected'
          ? <p role="alert">{t('rejected', { code: outcome.result.error.code, message: outcome.result.error.message })}</p>
          : outcome?.progress?.kind === 'pending'
            ? <p>{t('blocked', { reason: outcome.progress.reason, blockedBy: outcome.progress.blockedBy.join(', ') })}</p>
            : <p>{receipt.message}</p>}
      <Button onClick={() => { setReceipt(undefined) }}>{t('close')}</Button>
    </section>}
  </div>
}
