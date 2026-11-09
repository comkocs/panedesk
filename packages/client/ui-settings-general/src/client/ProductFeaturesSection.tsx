/** Numbered, expandable reference for product-owned automatic capabilities. */
import { useState } from 'react'
import { Button } from '@panedesk/dsh-client-ui-primitives'
import type { SettingsDescribeFace } from '@panedesk/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import { features } from './product-locales.ts'

/** Host path actions and the existing settings document snapshot. */
export interface ProductFeaturesInjected {
  hooks: { document: SettingsDescribeFace }
  open(key: 'configuration' | 'projects' | 'skills' | 'mcp' | 'agents'): Promise<boolean>
}

type Props = PropsRuntime<'settings.section'> & PropsLocale<'productFeatures'> & InjectFace<ProductFeaturesInjected>

/**
 * Render five plain-language facts per feature without changing configuration.
 * @param props - Locale, existing document location and Host open callback.
 * @returns The static numbered feature directory and explicit open feedback.
 */
export function ProductFeaturesSection({ t, useDocument, open }: Props) {
  const configuration = useDocument(value => value.view?.documentPath)
  const [failed, setFailed] = useState(false)
  return <section>
    <h2>{t('title')}</h2><p>{t('intro', { count: features.length })}</p>
    <ol>{features.map(feature => <li key={feature.id}>
      <details><summary>{t(`${feature.id}.title`)} · {feature.version}</summary>
        <p><strong>{t('what')}: </strong>{t(`${feature.id}.what`)}</p>
        <p><strong>{t('default')}: </strong>{t(`${feature.id}.default`)}</p>
        <p><strong>{t('trigger')}: </strong>{t(`${feature.id}.trigger`)}</p>
        <p><strong>{t('whether')}: </strong>{t(`${feature.id}.whether`)}</p>
        <p><strong>{t('where')}: </strong>{t(`${feature.id}.where`)} <code>{feature.path === 'configuration' ? configuration : feature.display}</code></p>
        <Button size="sm" variant="outline" disabled={feature.path === 'configuration' && !configuration}
          onClick={() => { void open(feature.path).then(ok => { setFailed(!ok) }).catch(() => { setFailed(true) }) }}>
          {t(feature.path === 'configuration' || feature.path === 'mcp' ? 'openFile' : 'openDirectory')}
        </Button>
      </details>
    </li>)}</ol>
    {failed && <p role="alert">{t('openFailed')}</p>}
  </section>
}
