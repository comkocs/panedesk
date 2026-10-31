/** A right-sidebar session transcript and its browser-local bookmark list. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsHooks, PropsLocale, PropsRenderSlots, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@panedesk/dsh-client-store'
import type { PinRead } from './pins.ts'
import { sessionTabParams } from './session.ts'
import { sessionTabAddress } from './resource.ts'
import css from './SessionTab.module.css'

/** Bookmark actions scoped to the page's selected session. */
export interface SessionTabInjected {
  /** Framework-bound source of browser-local bookmarks. */
  readonly hooks: { readonly pins: ObservableSnapshot<PinRead> }
  /** Jump only within this transcript occurrence.
   * @param root - page containing the target transcript.
   * @param messageId - stable message identity.
   * @param signal - cancel pagination callbacks when this occurrence leaves or starts another jump.
   * @returns whether the transcript contains the message after loading older pages.
   */
  jump(root: HTMLElement, messageId: string, signal?: AbortSignal): Promise<boolean>
}

/** Derived sidebar scope, authorized child slot, and bookmark callbacks. */
export type SessionTabBodyProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.session.conversation'> & PropsLocale<'sessionTab'> & Omit<SessionTabInjected, 'hooks'> & PropsHooks<SessionTabInjected['hooks']>

const NOTICE = { loading: 'body.loading', empty: 'body.empty', error: 'body.error', unavailable: 'body.unavailable' } as const

/** Render a separately retained session without changing the main selection.
 * @param props - tab identity, resource hook, child renderer, and bookmark actions.
 * @returns the existing conversation factory under the target Session provider.
 */
export function SessionTabBody({ t, useTabInfo, useResource, SessionProvider, renderSlot, usePins, jump }: SessionTabBodyProps): ReactNode {
  const opened = sessionTabParams(useTabInfo().tab.navigation.params)
  const resource = useResource<'sessiontab'>(opened === undefined ? '' : sessionTabAddress(opened.sessionId))
  const saved = usePins(value => value)
  const list = saved.status === 'ready' && opened !== undefined ? saved.pins.filter(pin => pin.sessionId === opened.sessionId) : []
  const shown = saved.status === 'error' || saved.status === 'unavailable' ? saved.status : (list.length === 0 ? 'empty' as const : undefined)
  const [missing, setMissing] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState<string | undefined>(undefined)
  const pending = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    setMissing(undefined)
    setLoading(undefined)
    return () => { pending.current?.abort() }
  }, [opened?.sessionId])
  return (
    <div className={css.body} data-session-tab={opened?.sessionId}>
      <details className={css.bookmarks}>
        <summary>{t('pin.list')}</summary>
        {shown !== undefined ? <span className={css.muted}>{t(NOTICE[shown])}</span> : null}
        {list.map(pin => (
          <button key={pin.messageId} type="button" className={css.pin} disabled={loading === pin.messageId} onClick={(event) => {
            const root = event.currentTarget.closest('[data-session-tab]')
            pending.current?.abort()
            const operation = new AbortController()
            pending.current = operation
            setMissing(undefined)
            setLoading(pin.messageId)
            const settle = (found: boolean): void => {
              if (operation.signal.aborted) return
              setLoading(undefined)
              setMissing(found ? undefined : pin.messageId)
            }
            if (root instanceof HTMLElement) void jump(root, pin.messageId, operation.signal).then(settle, () => { settle(false) })
            else settle(false)
          }}>
            <span>{pin.messageId}</span>
            <span className={css.muted}>{loading === pin.messageId ? t('pin.loading') : missing === pin.messageId ? t('body.gone') : t('pin.jump')}</span>
          </button>
        ))}
      </details>
      {resource.status === 'none' || resource.status === 'loading' ? <span role="status">{t('body.loading')}</span> : null}
      {resource.status === 'failed' ? <span role="alert">{t('session.error')}</span> : null}
      {resource.value === undefined ? null : (
        <SessionProvider session={resource.value.reference}>
          {renderSlot('sidebar.session.conversation', {})}
        </SessionProvider>
      )}
    </div>
  )
}
