/**
 * Windows Git Bash setup row: reports the first-run probe, offers the
 * one-click write of the confirmed selection, and carries the bilingual
 * install instructions when nothing is installed. Off-Windows hosts get a
 * one-line "not applicable here" body and no actions.
 */

import { useEffect, useState } from 'react'
import { IconPanedeskBash } from '@panedesk/dsh-client-ui-panedesk-icons'
import { Button } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { BashSetupStatus } from '@panedesk/dsh-host-bash-setup/types'
import css from './BashSetupRow.module.css'

/** One step of the row's asynchronous view over the host facts. */
export type BashSetupView =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly facts: BashSetupStatus }

/** Registration-side business face for the host-backed preference. */
export interface BashSetupRowInjected {
  /** Read the probe result, the committed selection, and the environment override. */
  read: () => Promise<BashSetupStatus>
  /** Commit the confirmed selection; the button click is the confirmation. */
  enable: (bashPath: string) => Promise<BashSetupStatus>
  /** Remove the committed selection so the platform default stands again. */
  disable: () => Promise<BashSetupStatus>
}

/** Full component props. */
export type BashSetupRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.bashSetup'>
  & InjectFace<BashSetupRowInjected>

type Translate = BashSetupRowProps['t']

/** The write target a ready view resolves to. */
type ReadyView = Extract<BashSetupView, { status: 'ready' }>['facts']

/** Whether the environment override already selected Bash for this host. */
function envSelected(facts: ReadyView): boolean {
  return facts.envOverride !== undefined && facts.envOverride !== ''
}

/**
 * Render the Git Bash setup row.
 * @param props - host reads and writes, and localized copy.
 * @returns the General Settings row.
 */
export function BashSetupRow({ read, enable, disable, t }: BashSetupRowProps) {
  const [view, setView] = useState<BashSetupView>({ status: 'loading' })
  const [busy, setBusy] = useState<'enable' | 'disable' | undefined>(undefined)
  const [failure, setFailure] = useState<'read' | 'enable' | 'disable' | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setFailure(undefined)
    setView({ status: 'loading' })
    read().then((facts) => {
      if (!cancelled) setView({ status: 'ready', facts })
    }).catch(() => {
      if (!cancelled) setView({ status: 'error' })
    })
    return () => { cancelled = true }
  }, [read])

  return <div className={css.row}>
    <div className={css.main}>
      <div className={css.title}><IconPanedeskBash />{t('title')}</div>
      <div className={css.description}>{t('description')}</div>
      {view.status === 'loading' && <div>{t('loading')}</div>}
      {view.status === 'error' && <div role="alert">{t('error')}</div>}
      {failure === 'read' && view.status !== 'error' && <div role="alert">{t('error')}</div>}
      {view.status === 'ready' && <ReadyFacts facts={view.facts} t={t} />}
      {view.status === 'ready' && failure === 'enable' && <div role="alert">{t('probe.failed')}</div>}
      {view.status === 'ready' && failure === 'disable' && <div role="alert">{t('committed.failed')}</div>}
    </div>
    <div className={css.actions}>
      {view.status === 'error' && <Button variant="outline" onClick={() => {
        setFailure(undefined)
        setView({ status: 'loading' })
        read().then((facts) => { setView({ status: 'ready', facts }) }).catch(() => { setFailure('read') })
      }}>{t('retry')}</Button>}
      {view.status === 'ready' && view.facts.probe !== undefined && view.facts.config === undefined
        && !envSelected(view.facts) && view.facts.platform === 'win32'
        && <EnableButton bashPath={view.facts.probe.bashPath} busy={busy} t={t} onEnable={enable}
          onBusy={() => { setFailure(undefined); setBusy('enable') }}
          onSettled={(next, failed) => {
            setFailure(failed ? 'enable' : undefined)
            if (next !== undefined) setView({ status: 'ready', facts: next })
            setBusy(undefined)
          }} />}
      {view.status === 'ready' && view.facts.config !== undefined
        && <Button variant="outline" disabled={busy !== undefined} onClick={() => {
          const next = disable()
          setFailure(undefined)
          setBusy('disable')
          void next.then((facts) => { setView({ status: 'ready', facts }) })
            .catch(() => { setFailure('disable') })
            .finally(() => { setBusy(undefined) })
        }}>{busy === 'disable' ? t('committed.busy') : t('committed.disable')}</Button>}
    </div>
  </div>
}

/** Enable button: the click is the confirmation for the probed executable. */
function EnableButton({ bashPath, busy, t, onEnable, onBusy, onSettled }: {
  bashPath: string
  busy: 'enable' | 'disable' | undefined
  t: Translate
  onEnable: BashSetupRowInjected['enable']
  onBusy: () => void
  onSettled: (next: BashSetupStatus | undefined, failed: boolean) => void
}) {
  return <Button variant="primary" disabled={busy !== undefined} onClick={() => {
    onBusy()
    const next = onEnable(bashPath)
    void next.then((facts) => { onSettled(facts, false) }, () => { onSettled(undefined, true) })
  }}>{busy === 'enable' ? t('probe.busy') : t('probe.write')}</Button>
}

/** The localized fact block for a settled read. */
function ReadyFacts({ facts, t }: { facts: ReadyView; t: Translate }) {
  if (facts.platform !== 'win32') return <div>{t('unsupported')}</div>
  if (envSelected(facts)) {
    return <div>
      <div>{t('env.title')}</div>
      <div className={css.path}>{t('env.path')}: {facts.envOverride}</div>
    </div>
  }
  if (facts.config !== undefined) {
    return <div>
      <div>{t('committed.title')} <span className={css.path}>{t('committed.path')}: {facts.config.bashPath}</span></div>
      <div className={css.hint}>{t('committed.restart')}</div>
    </div>
  }
  if (facts.probe !== undefined) {
    return <div>
      <div>{t('probe.found')} <span className={css.path}>{facts.probe.bashPath}</span></div>
      <div className={css.hint}>{t('probe.hint')}</div>
    </div>
  }
  return <div>
    <div>{t('notFound.title')}</div>
    <ul className={css.steps}>
      <li>{t('notFound.step1')}</li>
      <li>{t('notFound.step2')}</li>
      <li>{t('notFound.step3')}</li>
    </ul>
  </div>
}
