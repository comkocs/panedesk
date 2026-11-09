/** Per-tool ordinary-session preferences using the shared settings writer. */
import { useState } from 'react'
import { Button, Switch } from '@panedesk/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@panedesk/dsh-client-store'
import type { ConfigFormSnapshot } from '@panedesk/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import { toolDescriptionKey } from './tool-locales.ts'
import css from './DeveloperToolsRow.module.css'

/** Persisted disabled names; an empty list enables every available tool. */
export interface ToolSettings { disabledTools: string[] }

/** Accepted settings and their existing revision-fenced writer. */
export interface ToolsSectionInjected {
  hooks: { preferences: ObservableSnapshot<ConfigFormSnapshot<ToolSettings>> }
  save(disabledTools: string[]): Promise<boolean>
}

type Props = PropsRuntime<'settings.section'> & PropsLocale<'toolSettings'> & InjectFace<ToolsSectionInjected>

/** Render each registered tool, including tools currently disabled by preferences.
 * @param props - Catalog resource, accepted configuration, writer, and locale.
 * @returns The Tools settings page.
 */
export function ToolsSection({ useResource, usePreferences, save, t }: Props) {
  const catalog = useResource<'tool-catalog'>('dsh-resource://tool-catalog/current')
  const preferences = usePreferences(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const disabled = preferences.value?.disabledTools
  const writable = preferences.status === 'ready' && preferences.writable && !busy
  const persist = (names: string[]): void => {
    setBusy(true)
    setFailed(false)
    void save(names).then(accepted => { setFailed(!accepted) })
      .catch(() => { setFailed(true) }).finally(() => { setBusy(false) })
  }
  return <section>
    <p>{t('note')}</p><p>{t('conditions')}</p>
    <Button disabled={!writable} onClick={() => { persist([]) }}>{t('enableAll')}</Button>
    {failed && <p role="alert">{t('saveFailed')}</p>}
    {catalog.status === 'failed' || preferences.status === 'unavailable'
      ? <p role="alert">{t('failed')}</p>
      : !catalog.value || disabled === undefined ? <p>{t('loading')}</p>
      : catalog.value.map(tool => {
        const key = toolDescriptionKey(tool.name)
        return <div key={tool.name} className={css.row}>
          <div>
            <div className={css.title}>{tool.name}</div>
            <div className={css.description}>{key ? t(key) : tool.description}</div>
            <div className={css.description}>{t('tokens', { count: tool.tokens })}</div>
          </div>
          <Switch label={tool.name} checked={!disabled.includes(tool.name)} disabled={!writable}
            onChange={enabled => { persist(enabled ? disabled.filter(name => name !== tool.name) : [...disabled, tool.name]) }} />
        </div>
      })}
  </section>
}
