/** Session-header entry to the shared Browser panel. */
import type { ReactNode } from 'react'
import { Button } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type {} from '@panedesk/dsh-client-ui-conversation/client'

/** Header callback bound to the rendered Session. */
export interface BrowserButtonInjected {
  readonly openBrowser: () => void
}

type Props = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'sidebarBrowser'> & InjectFace<BrowserButtonInjected>

/** @param props - Localized label and Session-bound opening action. @returns the Browser entry. */
export function BrowserButton({ openBrowser, t }: Props): ReactNode {
  return <Button variant="toolbar" size="sm" onClick={openBrowser}>{t('type.label')}</Button>
}
