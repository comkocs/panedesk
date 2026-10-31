/** Seat entry presentations; all business facts arrive through the shared resource. */
import { useEffect, useState } from 'react'
import { Button, Input, Menu, Modal, StateDot, Toast, IconPlusOutlineRegular, IconWarningOutlineRegular, IconEllipsisOutlineRegular, IconFlatListOutlineRegular } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@panedesk/dsh-client-store'
import type { PreviewSeatImportRequest, SeatDefinition, SeatName } from '@panedesk/dsh-seat/types'
import type { SeatAddPlan, SeatAddRequest } from '../types.ts'
import type { SessionId } from '@panedesk/dsh-session/types'
import type {} from '@panedesk/dsh-working-directory'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-sidebar/client'
import type { SeatOverview } from '../types.ts'
import css from './Seats.module.css'

/** Interaction callbacks and transient feedback shared by the three entry presentations. */
export interface SeatsInjected {
  openSeat: (seat: SeatDefinition, startupDirectory?: string) => Promise<void>
  openProfiles?: (seat: SeatName) => void
  openOverview?: () => void
  openDesk?: (seat: SeatName) => void
  openWindow: (id: SessionId) => void
  closeWindow: (id: SessionId, stateVersion: number) => Promise<void>
  dismiss: () => void
  loadModels: () => Promise<readonly { provider: string; model: string; label: string; reasoningEffort?: string }[]>
  prepareAdd: (request: SeatAddRequest) => Promise<PreviewSeatImportRequest>
  previewAdd: (request: PreviewSeatImportRequest) => Promise<SeatAddPlan>
  commitAdd: (plan: SeatAddPlan) => Promise<void>
  refreshSeats?: () => void
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
    <div>{t('currentDirectory')}: {cwd}</div>
    <div>{t('profileDirectory')}: {pending?.directories.find(directory => directory.startup)?.path}</div>
  </Modal>
}

/** Four-field local draft; no catalog mutation occurs until its preview is confirmed. */
function AddSeat({ open, close, models, prepareAdd, previewAdd, commitAdd, refreshSeats, observation, live, t }: Pick<SeatsSectionProps,
  'prepareAdd' | 'previewAdd' | 'commitAdd' | 'refreshSeats' | 't'> & {
    observation: SeatOverview
    live: boolean
    open: boolean
    close: () => void
    models: Awaited<ReturnType<SeatsInjected['loadModels']>>
  }) {
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [opening, setOpening] = useState('')
  const [model, setModel] = useState<typeof models[number]>()
  const [menu, setMenu] = useState(false)
  const [plan, setPlan] = useState<SeatAddPlan>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [refreshBase, setRefreshBase] = useState<SeatOverview>()
  useEffect(() => {
    if (refreshBase && live && observation !== refreshBase) {
      setUncertain(false); setRefreshBase(undefined); setError('')
    }
  }, [refreshBase, live, observation])
  const preview = async (): Promise<void> => {
    if (!model) { setError(t('modelRequired')); return }
    if (!name.trim() || !directory.trim() || !opening.trim()) { setError(t('fieldsRequired')); return }
    setBusy(true); setError('')
    try {
      const source = await prepareAdd({ name, directory, opening, provider: model.provider, model: model.model,
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) })
      const next = await previewAdd(source)
      if (next.rows.filter(row => row.action === 'create').length !== 1
        || next.rows.some(row => row.action !== 'create' && row.action !== 'retain')
        || next.rows.some(row => row.diagnostics.length > 0)) { setError(t('previewRejected')); return }
      setPlan(next)
    } catch (failure) {
      const code = failure instanceof Error && 'code' in failure ? failure.code : undefined
      setError(t(code === 'seat-ui/name-exists' ? 'nameExists' : code === 'seat-ui/directory-invalid' ? 'directoryInvalid' : 'previewRejected'))
    } finally { setBusy(false) }
  }
  const commit = async (): Promise<void> => {
    if (!plan) return
    setBusy(true); setError('')
    try { await commitAdd(plan); close() }
    catch (failure) {
      setPlan(undefined); setError(t('commitRejected'))
      if (!(failure instanceof Error && failure.name === 'SeatWriteRejected')) { setRefreshBase(undefined); setUncertain(true) }
    }
    finally { setBusy(false) }
  }
  const changed = (): void => { setPlan(undefined); setError('') }
  return <Modal open={open} title={t('addSeat')} closeLabel={t('close')} onClose={() => { if (!busy) close() }} footer={<>
    <Button disabled={busy} onClick={close}>{t('cancel')}</Button>
    {uncertain && <Button disabled={busy || !refreshSeats} onClick={() => { setRefreshBase(observation); refreshSeats?.() }}>{t('retry')}</Button>}
    <Button variant="primary" disabled={busy || uncertain || !live} onClick={() => { void (plan ? commit() : preview()) }}>
      {t(plan ? 'confirmAdd' : 'preview')}</Button>
  </>}>
    <label>{t('seatName')}<Input aria-label={t('seatName')} data-modal-autofocus value={name} disabled={busy}
      onChange={(event) => { setName(event.target.value); changed() }} /></label>
    <label>{t('workingDirectory')}<Input aria-label={t('workingDirectory')} value={directory} disabled={busy}
      onChange={(event) => { setDirectory(event.target.value); changed() }} /></label>
    <div>{t('model')}<Menu open={menu} onClose={() => { setMenu(false) }}
      items={models.map((entry, index) => ({ id: String(index), label: entry.label }))}
      onSelect={(id) => { setModel(models[Number(id)]); setMenu(false); changed() }}
      anchor={<Button disabled={busy} aria-haspopup="menu" aria-expanded={menu} onClick={() => { setMenu(!menu) }}>
        {model?.label ?? t('selectModel')}</Button>} /></div>
    <label>{t('openingSentence')}<Input aria-label={t('openingSentence')} value={opening} disabled={busy}
      onChange={(event) => { setOpening(event.target.value); changed() }} /></label>
    {models.length === 0 && <p role="status">{t('noModels')}</p>}
    {plan && <p role="status">{t('oneCreate')}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}

/** Persistent diagnostics do not imply that an absent opening is a Session. */
function Diagnostics({ data, t }: { data: SeatOverview | undefined; t: Common['t'] }) {
  const failure = data?.diagnostics?.engine
  if (!failure && !data?.diagnostics?.openings.length && !data?.diagnostics?.callbacks?.length) return null
  return <div className={css.diagnostics}>
    {failure && <p role="alert">{t(failure.retryable ? 'engineRetrying' : 'engineStopped', { code: failure.code })}</p>}
    {failure?.unavailableOverTenMinutes && <p role="alert">{t('engineUnavailableOverTenMinutes', { code: failure.code })}</p>}
    {data.diagnostics?.callbacks?.map(callback => <p role="alert" key={callback.callbackId}>
      {callback.seat}: {t(callback.code === 'callback-authentication-failed' ? 'callbackAuthenticationRefused' : 'callbackIssuerRefused',
        { callback: callback.callbackId, code: callback.code })}
    </p>)}
    {data.diagnostics?.openings.map(open => <p role="alert" key={open.sessionId}>
      {open.seat}: {open.detail === 'restart-manual-opening-closed' ? t('restartManualClosed')
        : open.detail === 'restart-source-wake-closed' ? t('restartWakeClosed')
          : open.code === 'invalid-definition'
            ? t(open.stage === 'turn' ? 'admissionDefinition' : 'invalidDefinition', { code: open.code }) : open.model !== undefined
              ? t(open.stage === 'turn' ? 'liveModelUnavailable' : 'modelUnavailable',
                { model: open.model, provider: open.provider ?? '', code: open.code })
              : t('missingPreset', { preset: open.agentPreset, code: open.code })}
    </p>)}
  </div>
}

/** Render the pre-session picker without selecting a seat implicitly.
 * @param props - Slot runtime, locale and interaction callbacks.
 * @returns Picker and directory confirmation, or nothing when no seats are available.
 */
export function SeatPicker({ currentDirectory: cwd, useResource, useSeatNotice, dismiss, openSeat, t }: SeatPickerProps) {
  const notice = useSeatNotice(value => value)
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
    {notice !== null && notice.sessionId === undefined && <Toast key={notice.seq} text={notice.message} onDone={dismiss} />}
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
 * @returns The diagnostic indicator or seat section, including an empty catalog; absent providers add no space without diagnostics.
 */
export function SeatsSection({ wide, expandSidebar, useResource, useSessions, openSeat, openWindow, closeWindow,
  loadModels, prepareAdd, previewAdd, commitAdd, refreshSeats, openProfiles, openOverview, openDesk, t }: SeatsSectionProps) {
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
  const [menuSeat, setMenuSeat] = useState<SeatName | null>(null)
  const [headingHovered, setHeadingHovered] = useState(false)
  const [adding, setAdding] = useState(false)
  const [models, setModels] = useState<Awaited<ReturnType<SeatsInjected['loadModels']>>>([])
  const [addFailure, setAddFailure] = useState(false)
  const data = resource.value
  const hasDiagnostics = Boolean(data?.diagnostics?.engine || data?.diagnostics?.openings.length || data?.diagnostics?.callbacks?.length)
  if (!wide) return hasDiagnostics
    ? <Button size="sm" icon={<IconWarningOutlineRegular />} aria-label={t('showAlerts')}
      title={t('showAlerts')} onClick={expandSidebar} /> : null
  if (!hasDiagnostics && !data?.available) return null
  if (data === undefined) return null
  return <section className={css.section} aria-label={t('seats')}>
    <h2 className={css.heading} onMouseEnter={() => { setHeadingHovered(true) }} onMouseLeave={() => { setHeadingHovered(false) }}
      onFocus={() => { setHeadingHovered(true) }} onBlur={() => { setHeadingHovered(false) }} tabIndex={0}>
      {t('seats')}{headingHovered && <Button size="sm" aria-label={t('overview')} title={t('overview')}
        disabled={!openOverview} icon={<IconFlatListOutlineRegular />} onClick={openOverview} />}
    </h2>
    {data.available && <Button size="sm" disabled={!data.complete || resource.status === 'failed'}
      onClick={() => { setAddFailure(false); void loadModels().then((value) => { setModels(value); setAdding(true) },
        () => { setAddFailure(true) }) }}>{t('addSeat')}</Button>}
    {data.available && data.definitions.length === 0 && <p>{t('empty')}</p>}
    {addFailure && <p role="alert">{t('modelsFailed')}</p>}
    {adding && <AddSeat open close={() => { setAdding(false) }} models={models}
      prepareAdd={prepareAdd} previewAdd={previewAdd} commitAdd={commitAdd} {...(refreshSeats ? { refreshSeats } : {})}
      observation={data} live={resource.status === 'live'} t={t} />}
    <Diagnostics data={data} t={t} />
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
          {windows.some(window => window.status === 'approval-pending') && <span role="status">{t('approvalPending')}</span>}
          {windows.length > 0 && <span title={t(activity)}><StateDot state={unknown ? 'warning' : busy ? 'ongoing' : 'idle'} /></span>}
          <Menu open={menuSeat === seat.seat} onClose={() => { setMenuSeat(null) }}
            items={[
              { id: 'new', label: t('newSession'), disabled: !data.complete || resource.status === 'failed' || directory.ambiguous },
              { id: 'profile', label: t('seatProfile'), disabled: !openProfiles },
              { id: 'desk', label: t('viewInDesk'), disabled: !openDesk },
              { id: 'overview', label: t('overview'), disabled: !openOverview },
            ]} onSelect={(id) => {
              setMenuSeat(null)
              if (id === 'profile') openProfiles?.(seat.seat)
              else if (id === 'desk') openDesk?.(seat.seat)
              else if (id === 'overview') openOverview?.()
              else if (id === 'new') {
                const startup = seat.directories.find(directory => directory.startup)?.path
                if (cwd !== undefined && startup !== undefined && cwd !== startup) setPending(seat)
                else void openSeat(seat)
              }
            }} anchor={<Button size="sm" className={css.add} aria-label={t('seatActions')} title={t('seatActions')}
              aria-haspopup="menu" aria-expanded={menuSeat === seat.seat} icon={<IconEllipsisOutlineRegular />}
              onClick={() => { setMenuSeat(menuSeat === seat.seat ? null : seat.seat) }} />} />
          <Button size="sm" className={css.add} disabled={!data.complete || resource.status === 'failed' || directory.ambiguous}
            aria-label={t('open')} title={t('open')} icon={<IconPlusOutlineRegular />}
            onClick={() => {
              const startup = seat.directories.find(directory => directory.startup)?.path
              if (cwd !== undefined && startup !== undefined && cwd !== startup) setPending(seat)
              else void openSeat(seat)
            }} />
        </div>
        {expanded === seat.seat && windows.map(window => <div key={window.sessionId} className={css.row}>
          <Button size="sm" className={css.window} onClick={() => { openWindow(window.sessionId) }}>{window.title}</Button>
          <Button size="sm" disabled={!data.complete || resource.status !== 'live' || window.evidence === 'unknown'}
            onClick={() => { void closeWindow(window.sessionId, window.stateVersion) }}>{t('closeWindow')}</Button>
        </div>)}
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
