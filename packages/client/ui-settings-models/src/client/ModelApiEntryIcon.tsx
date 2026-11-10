/** Sidebar glyph for the Model API row; the sidebar owns the button, label, and click. */

import type { ReactNode } from 'react'
import { IconApiOutlineRegular } from '@panedesk/dsh-client-ui-primitives'
import type { PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type {} from '@panedesk/dsh-client-ui-sidebar/client'

/**
 * Render the API glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the row is selected.
 * @returns the icon element.
 */
export function ModelApiEntryIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconApiOutlineRegular size={size} />
}
