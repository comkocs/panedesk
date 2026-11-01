/** Assistant-message action that pins or unpins that message. */
import { useState, type ReactNode } from 'react'
import { IconPinOutlineRegular } from '@panedesk/dsh-client-ui-primitives'
import type { PropsHooks, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { SessionTabInjected } from './SessionTabBody.tsx'
import css from './SessionTab.module.css'

/** What the action needs from its registration. */
export interface PinActionInjected {
  /** Browser-local bookmark source shared by action occurrences. */
  readonly hooks: SessionTabInjected['hooks']
  /**
   * Pin or unpin this message.
   * @param messageId - the message the action sits on.
   * @returns the stored state, or `failed` when the write did not land.
   */
  toggle(messageId: string): 'pinned' | 'unpinned' | 'failed'
}

/** Props of the pin action. */
export type PinActionProps =
  & PropsRuntime<'conversation.chat.assistant-actions'>
  & PropsLocale<'sessionTab'>
  & Omit<PinActionInjected, 'hooks'> & PropsHooks<PinActionInjected['hooks']>

/**
 * Pin control for one finalized assistant message. Pinning stores a bookmark and
 * changes nothing the model receives.
 * @param props - the message, the copy, and the pin store.
 * @returns the control and click feedback, or null for the minimal preset.
 */
export function PinAction({ sessionId, messageId, useSessions, usePins, toggle, t }: PinActionProps): ReactNode {
  const minimal = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset === 'minimal')
  const pins = usePins(value => value)
  const on = pins.status === 'ready' && pins.pins.some(pin => pin.sessionId === sessionId && pin.messageId === messageId)
  const [saved, setSaved] = useState<boolean | undefined>(undefined)
  if (minimal) return null
  return (
    <span className={css.actionWrap}>
      <button type="button" className={css.action} aria-pressed={on} title={on ? t('pin.remove') : t('pin.add')}
        aria-label={on ? t('pin.remove') : t('pin.add')} onClick={() => {
          const stored = toggle(messageId)
          if (stored === 'failed') { setSaved(false); return }
          setSaved(true)
        }}>
        <IconPinOutlineRegular />
      </button>
      {saved === true && <span role="status">{t('pin.saved')}</span>}
      {saved === false && <span role="status">{t('pin.failed')}</span>}
    </span>
  )
}
