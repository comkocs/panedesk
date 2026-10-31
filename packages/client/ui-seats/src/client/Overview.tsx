/** Middle-column seat facts and manual batch opening. */
import { useEffect, useState } from 'react'
import { Button, Checkbox } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { SeatName } from '@panedesk/dsh-seat/types'
import css from './Seats.module.css'

/** Manual overview interactions; no ticket identity enters batch opening. */
export interface OverviewInjected {
  batch(this: void, seats: readonly SeatName[]): Promise<void>
  refresh(this: void): void
}
/** Main-panel props from framework shares. */
export type OverviewProps = PropsRuntime<'main'> & PropsLocale<'seats'> & InjectFace<OverviewInjected>

/** Render a complete observation or block writes when it cannot be trusted. */
export function Overview({ useResource, batch, refresh, t }: OverviewProps) {
  const resource = useResource<'seat-dashboard'>('dsh-resource://seat-dashboard/local')
  const [selected, setSelected] = useState<readonly SeatName[]>([])
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<'success' | 'failure' | null>(null)
  const data = resource.value
  const [uncertain, setUncertain] = useState(false)
  const [refreshBase, setRefreshBase] = useState<typeof data>()
  useEffect(() => {
    if (refreshBase && data && data !== refreshBase && resource.status === 'live') {
      setUncertain(false); setRefreshBase(undefined); setOutcome(null)
    }
  }, [data, refreshBase, resource.status])
  const observe = (): void => { setRefreshBase(data); refresh() }
  if (resource.status === 'failed') return <section><h1>{t('overview')}</h1><p role="alert">{t('overviewFailed')}</p><Button onClick={observe}>{t('retry')}</Button></section>
  if (!data) return <p role="status">{t('loading')}</p>
  const checked = selected.filter(name => data.definitions.some(item => item.seat === name))
  return <section className={css.overview}>
    <h1>{t('overview')}</h1>
    <Button disabled={busy || uncertain || resource.status !== 'live' || checked.length === 0} onClick={() => {
      setBusy(true); setOutcome(null); setRefreshBase(undefined)
      void batch(checked).then(() => { setOutcome('success'); setSelected([]) }, (error: unknown) => { setOutcome('failure'); if (!(error instanceof Error && error.name === 'SeatWriteRejected')) setUncertain(true) })
        .finally(() => { setBusy(false) })
    }}>{t(busy ? 'loading' : 'batchOpen')}</Button>
    <Button disabled={busy} onClick={observe}>{t('retry')}</Button>
    {outcome && <p role={outcome === 'failure' ? 'alert' : 'status'}>{t(outcome === 'success' ? 'batchSuccess' : 'batchFailed')}</p>}
    {data.definitions.length === 0 ? <p>{t('empty')}</p> : <table>
      <thead><tr>{(['seatName', 'node', 'opened', 'model', 'recentOpen', 'pendingCount'] as const).map(key => <th key={key}>{t(key)}</th>)}</tr></thead>
      <tbody>{data.definitions.map(seat => <tr key={seat.seat}>
        <td><Checkbox label={seat.seat} checked={checked.includes(seat.seat)} disabled={busy}
          onChange={(value) => { setSelected(value ? [...checked, seat.seat] : checked.filter(name => name !== seat.seat)) }} /></td>
        <td>{seat.node}</td><td>{t(data.windows.some(window => window.seat === seat.seat) ? 'opened' : 'unopened')}</td>
        <td>{seat.provider} / {seat.model}</td><td>{data.recentOpen[seat.seat] ?? t('neverOpened')}</td>
        <td>{data.pending.filter(item => item.seat === seat.seat).length}</td>
      </tr>)}</tbody>
    </table>}
  </section>
}
