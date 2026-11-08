/** Panedesk preferences are contributed by the feature that owns each row. */
import type { PropsRenderSlots, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import css from './GeneralSection.module.css'

type PanedeskSectionProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.panedesk.item'>

/**
 * Render the Panedesk features preference column, initially empty.
 * @param props - section owner props and authorized item renderer.
 * @returns the contributed Panedesk preference rows.
 */
export function PanedeskSection({ renderSlot }: PanedeskSectionProps) {
  return <div className={css.section}>{renderSlot('settings.panedesk.item', {})}</div>
}
