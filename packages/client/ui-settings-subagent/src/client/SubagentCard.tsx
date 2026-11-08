/** One settings card for Subagent delegation limits. */

import { useId } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type {} from '@panedesk/dsh-client-ui-plugin-manager/client'
import { SettingsForm } from '@panedesk/dsh-client-ui-primitives'
import { formLabels } from './locales.ts'
import { SubagentLimitsFields } from './SubagentLimitsFields.tsx'
import type { SubagentLimitsCardFace } from './subagent-limits-card-controller.ts'
import css from './SubagentCard.module.css'

/** Framework-derived props for the shared Subagent settings card. */
export type SubagentCardProps = PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.subagent'> & InjectFace<SubagentLimitsCardFace>

/**
 * Render the available Subagent settings with one configuration page and save footer.
 * @param props - Locale, the limits snapshot, and its actions.
 * @returns The summary or the available settings form.
 */
export function SubagentCard(props: SubagentCardProps) {
  const { t } = props
  const limits = props.useSubagentLimitsCard(snapshot => snapshot)
  const headingId = useId()
  if (props.view === 'summary') return t('subagentDescription')
  const state = limits
  return (
    <SettingsForm labels={formLabels(t)}
      state={state} onSave={props.save} onDiscard={props.discard}>
      {limits.available
        ? (
          <section className={css.section} aria-labelledby={`${headingId}-limits`}>
            <h3 className={css.heading} id={`${headingId}-limits`}>{t('subagentLimitsTitle')}</h3>
            <SubagentLimitsFields t={t} state={{ ...limits, saving: state.saving }}
              edit={props.edit} resetField={props.resetField} />
          </section>
        )
        : null}
    </SettingsForm>
  )
}
