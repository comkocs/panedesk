/** Seat entry presentations; all business facts arrive through the shared resource. */
import { useState } from 'react'
import { Button, Menu, Modal, StateDot, Toast, IconPlusOutlineRegular } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@panedesk/dsh-client-store'
import type { SeatDefinition, SeatName } from '@panedesk/dsh-seat/types'
import type { SessionId } from '@panedesk/dsh-session/types'
import type {} from '@panedesk/dsh-working-directory'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-sidebar/client'
import type { SeatOverview } from '../types.ts'
import css from './Seats.module.css'

/** Interaction callbacks and transient feedback shared by the three entry presentations. */
export interface SeatsInjected {
  openSeat: (seat: SeatDefinition, startupDirectory?: string) => Promise<void>
  openWindow: (id: SessionId) => void
  dismiss: () => void
  hooks: { seatNotice: ObservableSnapshot<{ seq: number; message: string; sessionId?: SessionId } | null> }
}

type Common = InjectFace<SeatsInjected> & PropsLocale<'seats'>
/** Props derived from the cold-start slot and injected interaction callbacks. */
export type SeatPickerProps = PropsRuntime<'conversation.hero.seat'> & Common
/** Props derived from the shell-owned section slot. */
export type SeatsSectionProps = PropsRuntime<'sidebar.seats'> & Common
/** Props derived from the occurrence-scoped header slot. */
export type SeatHeaderProps = PropsRuntime<'conversation.header.seat'> & Common

type DirectoryConfirmationProps = Pick<SeatPickerProps, 'openSeat' | 't'> & {
  cwd: string | undefined
  pending: SeatDefinition | null
  setPending: (seat: SeatDefinition | null) => void
}

/** Shared directory choice for the picker and sidebar opening entries. */
function DirectoryConfirmation({ cwd, pending, setPending, openSeat, t }: DirectoryConfirmationProps) {
  return <Modal open={pending !== null} title={t('directoryTitle')} closeLabel={t('close')} onClose={() => { setPending(null) }}
    description={t('directoryDescription')} footer={<>
      <Button onClick={() => { setPending(null) }}>{t('cancel')}</Button>
      <Button onClick={() => { const seat = pending; setPending(null); if (seat && cwd !== undefined) void openSeat(seat, cwd) }}>{t('here')}</Button>
      <Button variant="primary" onClick={() => { const seat = pending; setPending(null); if (seat) void openSeat(seat) }}>{t('profile')}</Button>
    </>}>
    {cwd}
  </Modal>
}

/** Render the pre-session picker without selecting a seat implicitly.
 * @param props - Slot runtime, locale and interaction callbacks.
 * @returns Picker and directory confirmation, or nothing when no seats are available.
 */
export function SeatPicker({ currentDirectory: cwd, useResource, openSeat, t }: SeatPickerProps) {
  const resource = useResource<'seats'>('dsh-resource://seats/local')
  const [menu, setMenu] = useState(false)
  const [pending, setPending] = useState<SeatDefinition | null>(null)
  const data = resource.value
  if (!data?.available || data.definitions.length === 0) return null
  const pick = (seat: SeatDefinition): void => {
    setMenu(false)
    const startup = seat.directories.find(directory => directory.startup)?.path
    if (cwd !== undefined && startup !== undefined && cwd !== startup) setPending(seat)
    else void openSeat(seat)
  }
  return <>
    <Menu open={menu} onClose={() => { setMenu(false) }} portal align="start"
      items={data.definitions.map(seat => ({ id: seat.seat, label: seat.seat, disabled: !data.complete }))}
      onSelect={(id) => { const seat = data.definitions.find(row => row.seat === id); if (seat) pick(seat) }}
      anchor={<Button size="sm" aria-haspopup="menu" aria-expanded={menu} disabled={!data.complete || resource.status === 'failed'}
        title={data.complete ? t('open') : t('incomplete')} onClick={() => { setMenu(!menu) }}>{t('seat')}</Button>} />
    <DirectoryConfirmation cwd={cwd} pending={pending} setPending={setPending} openSeat={openSeat} t={t} />
  </>
}

/** Render seat rows and expand only the selected seat's existing windows.
 * @param props - Shell width and injected local opening/navigation actions.
 * @returns The optional seat section; no placeholder space when providers or definitions are absent.
 */
export function SeatsSection({ wide, useResource, useSessions, openSeat, openWindow, t }: SeatsSectionProps) {
  const resource = useResource<'seats'>('dsh-resource://seats/local')
  const directory = useSessions((snapshot) => {
    const rows = snapshot.ids.map(id => snapshot.byId[id])
      .filter(row => row !== undefined && (row.retainedBy.mainView ?? 0) > 0)
    const row = rows.length === 1 ? rows[0] : undefined
    return { cwd: row?.projectionValues?.workingDirectory ?? row?.cwd, ambiguous: rows.length > 1 }
  })
  const cwd = directory.cwd
  const [pending, setPending] = useState<SeatDefinition | null>(null)
  const [expanded, setExpanded] = useState<SeatName | null>(null)
  const data = resource.value
  if (!wide || !data?.available || data.definitions.length === 0) return null
  return <section className={css.section} aria-label={t('seats')}>
    <h2 className={css.heading}>{t('seats')}</h2>
    {resource.status === 'failed' && <p role="alert">{t('unavailable')}</p>}
    {!data.complete && <p role="alert">{t('incomplete')}</p>}
    {directory.ambiguous && <p role="status">{t('directoryAmbiguous')}</p>}
    {data.definitions.map((seat) => {
      const windows = data.windows.filter(window => window.seat === seat.seat)
      const unknown = !data.complete || windows.some(window => window.evidence === 'unknown' || window.status === null)
      const busy = windows.some(window => window.status === 'running' || window.busyReasons.length > 0)
      const activity = unknown ? 'unknown' : busy ? 'busy' : 'idle'
      return <div key={seat.seat} className={css.group}>
        <div className={css.row}>
          <Button size="sm" aria-expanded={expanded === seat.seat} className={css.name}
            onClick={() => { setExpanded(expanded === seat.seat ? null : seat.seat) }}>
            <StateDot state={windows.length > 0 ? 'done' : 'idle'} /><span>{seat.seat}</span>
          </Button>
          <span title={t(windows.length > 0 ? 'opened' : 'unopened')} className={css.status}>
            {t(windows.length > 0 ? 'opened' : 'unopened')}
          </span>
          {windows.length > 0 && <span title={t(activity)}><StateDot state={unknown ? 'warning' : busy ? 'ongoing' : 'idle'} /></span>}
          <Button size="sm" className={css.add} disabled={!data.complete || resource.status === 'failed' || directory.ambiguous}
            aria-label={t('open')} title={t('open')} icon={<IconPlusOutlineRegular />}
            onClick={() => {
              const startup = seat.directories.find(directory => directory.startup)?.path
              if (cwd !== undefined && startup !== undefined && cwd !== startup) setPending(seat)
              else void openSeat(seat)
            }} />
        </div>
        {expanded === seat.seat && windows.map(window => <Button key={window.sessionId} size="sm" className={css.window}
          onClick={() => { openWindow(window.sessionId) }}>{window.title}</Button>)}
      </div>
    })}
    <DirectoryConfirmation cwd={cwd} pending={pending} setPending={setPending} openSeat={openSeat} t={t} />
  </section>
}

/** Render occurrence-local identity and one shared refusal Toast.
 * @param props - Occurrence Session identity, resource and locale hooks.
 * @returns Seat and node label, free-window label, or unavailable evidence, plus transient feedback.
 */
export function SeatHeader({ sessionId, useResource, useSeatNotice, dismiss, t }: SeatHeaderProps) {
  const resource = useResource<'seats'>(sessionId === undefined ? 'dsh-resource://seats/local'
    : `dsh-resource://seats/local?session=${encodeURIComponent(sessionId)}`)
  const notice = useSeatNotice(value => value)
  const binding = resource.value?.binding
  const current = binding && 'kind' in binding && binding.sessionId === sessionId ? binding : undefined
  const node = current?.kind === 'seat' ? resource.value?.definitions.find(row => row.seat === current.seat)?.node : undefined
  const failed = resource.status === 'failed' || resource.value?.identityStatus === 'failed'
    || (resource.status === 'live' && current === undefined)
  const label = sessionId === undefined ? t('free')
    : current?.kind === 'seat' ? `${current.seat} · ${node ?? current.nodeId}`
      : current?.kind === 'free' ? t('free') : t(failed ? 'identityFailed' : 'identityLoading')
  const abnormal = sessionId !== undefined && current !== undefined
    && (resource.status !== 'live' || !resource.value?.complete || resource.value.identityStatus === 'failed')
  return <>
    <span className={css.identity}>{label}</span>
    {abnormal && <span role="status">{t(failed ? 'identityFailed' : resource.status === 'live' ? 'unavailable' : 'identityLoading')}</span>}
    {notice !== null && (notice.sessionId === undefined || notice.sessionId === sessionId)
      && <Toast key={notice.seq} text={notice.message} onDone={dismiss} />}
  </>
}

declare module '@panedesk/dsh-client-ui-slots' {
  interface ResourceProtocolMap { seats: SeatOverview }
}
