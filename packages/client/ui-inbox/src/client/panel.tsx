/** Session-header inbox with resource-owned reads and local disclosure state. */
import { useState } from 'react'
import { IconPanedeskInbox } from '@panedesk/dsh-client-ui-panedesk-icons'
import { Button, Modal, Tag } from '@panedesk/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { InboxKey } from './locales.ts'
import css from './panel.module.css'

type Props = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'inbox'>

/** Render only inside an existing Session header, never the initial home screen.
 * @param props - Standard Session identity, framework resource reader and locale seat.
 * @returns Inbox entry, conditional isolation warning and read-only message modal.
 */
export function InboxPanel({ sessionId, useResource, t }: Props) {
  const inbox = useResource<'inbox'>(`dsh-resource://inbox/${encodeURIComponent(sessionId)}`)
  const [open, setOpen] = useState(false), [reasons, setReasons] = useState(false)
  const value = inbox.value
  const code = inbox.failure?.code
  const state: InboxKey = code === 'inbox/unauthorized' ? 'unauthorized' : value?.enabled === false ? 'disabled'
    : inbox.status === 'failed' ? value ? 'failed' : 'error' : inbox.status === 'loading' ? 'loading'
      : !value ? 'idle' : !value.complete ? 'partial' : !value.items.length ? 'empty' : 'success'
  return <div className={css.entry}>
    <Button variant="toolbar" onClick={() => { setReasons(false); setOpen(true) }}><IconPanedeskInbox />{t('title')}</Button>
    {!!value?.quarantined.length && <span role="alert"><Button variant="toolbar" onClick={() => { setReasons(true); setOpen(true) }}>
      {t('quarantine', { count: value.quarantined.length })}
    </Button></span>}
    <Modal open={open} onClose={() => { setOpen(false) }} title={t(reasons ? 'reasons' : 'title')} closeLabel={t('close')}>
      <p role={inbox.status === 'failed' ? 'alert' : 'status'}>{t(state)}</p>
      {reasons ? <ul>{value?.quarantined.map(event => <li key={event.cursor}>
        <time dateTime={new Date(event.observedAt).toISOString()}>{new Date(event.observedAt).toISOString()}</time> {t(event.reason)}
      </li>)}</ul> : !!value?.items.length && <table className={css.table}>
        <thead><tr><th>{t('sender')}</th><th>{t('time')}</th><th>{t('priority')}</th><th>{t('state')}</th></tr></thead>
        <tbody>{value.items.map(({ status, senderSeat }) => <tr key={status.messageId}>
          <td>{senderSeat ?? t(status.metadata?.senderSessionId === null ? 'human' : 'unknown')}</td>
          <td>{status.metadata ? <time dateTime={new Date(status.metadata.createdAt).toISOString()}>{new Date(status.metadata.createdAt).toISOString()}</time> : t('unknown')}</td>
          <td>{status.metadata ? t(status.metadata.priority) : t('unknown')}</td>
          <td><Tag>{t(status.state)}</Tag></td>
        </tr>)}</tbody>
      </table>}
    </Modal>
  </div>
}
