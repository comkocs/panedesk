/** Panedesk preferences are contributed by the feature that owns each row. */
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import css from './GeneralSection.module.css'

type PanedeskSectionProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.panedesk.item'> & PropsLocale<'settings'>

/**
 * Render the Panedesk feature introduction and contributed preference rows.
 * @param props - section owner props and authorized item renderer.
 * @returns the contributed Panedesk preference rows.
 */
export function PanedeskSection({ renderSlot, t }: PanedeskSectionProps) {
  return <div className={css.section}>
    <p>{t('panedesk.description')}</p>
    {renderSlot('settings.panedesk.item', {})}
  </div>
}
